import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Logger,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { appConfig } from '../config/app.config';
import { signSessionToken, verifySessionToken } from '../common/crypto.util';
import { CasService } from './cas.service';
import { AuthGuard, OptionalAuthGuard, type AuthenticatedRequest } from './auth.guard';
import { IcspService } from '../library/icspace.service';

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly casService: CasService,
    private readonly icspService: IcspService,
  ) {}

  private isSecureRequest(req: Request): boolean {
    const origin = this.casService.getCanonicalOrigin(req);
    return origin.startsWith('https://');
  }

  private setSessionCookie(res: Response, req: Request, token: string) {
    res.cookie(appConfig.sessionCookieName, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.isSecureRequest(req),
      path: '/',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
  }

  private clearSessionCookies(res: Response, req: Request) {
    const opts = {
      httpOnly: true,
      sameSite: 'lax' as const,
      secure: this.isSecureRequest(req),
      path: '/',
    };
    res.clearCookie(appConfig.sessionCookieName, opts);
    res.clearCookie(appConfig.returnToCookieName, opts);
  }

  private hasValidExistingSession(req: Request): boolean {
    const cookieToken = req.cookies?.[appConfig.sessionCookieName];
    if (!cookieToken) return false;
    const payload = verifySessionToken(cookieToken);
    if (!payload) return false;
    return Boolean(this.casService.findUserById(payload.uid));
  }

  @Get('config')
  getAuthConfig(@Req() req: Request) {
    const ip = this.casService.getClientIp(req);
    const isInternal = this.casService.isInternalNetwork(ip);
    const callbackUrl = this.casService.getCallbackUrl(req);
    return {
      casServerUrl: appConfig.cas.serverUrl,
      callbackUrl,
      isInternalNetwork: isInternal,
      mockMode: appConfig.mockMode,
    };
  }

  /**
   * 跳转到 DLUFL-CAS 域名进行统一身份验证。
   * - service 固定为规范化的 /api/auth/cas/callback（不含动态参数，杜绝二次登录或回调 service 不一致）
   * - returnTo 存入短期 HttpOnly Cookie
   * - 支持 ?renew=true 强制在 CAS 重新输入密码（用于切换账号）
   */
  @Get('cas/login')
  redirectToCas(
    @Req() req: Request,
    @Res() res: Response,
    @Query('next') nextPath?: string,
    @Query('renew') renew?: string,
    @Query('mode') mode?: string,
  ) {
    const safeNext = this.casService.sanitizeReturnTo(nextPath);
    res.cookie(appConfig.returnToCookieName, safeNext, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.isSecureRequest(req),
      path: '/',
      maxAge: 10 * 60 * 1000,
    });

    const callbackUrl = this.casService.getCallbackUrl(req);
    const forceRenew = renew === 'true' || renew === '1';

    // 仅当客户端显式请求 mode=intranet 时才走内网无跳转页面，默认直接跳转到 cas.dlufl.edu.cn
    if (mode === 'intranet') {
      const frontendBase = this.casService.getFrontendBaseUrl(req);
      return res.redirect(302, `${frontendBase}/?intranetLogin=1`);
    }

    const targetUrl = this.casService.getCasLoginRedirectUrl(callbackUrl, forceRenew);
    this.logger.log(`Redirecting to CAS: ${targetUrl}`);
    return res.redirect(302, targetUrl);
  }

  /**
   * DLUFL-CAS 验证回调端点（服务端单次验证 ST 票据 -> Upsert 用户 -> 下发 HttpOnly Cookie -> 302 干净跳转前端）。
   * 解决常见的三大坑：
   * 1) 前端 React StrictMode 二次请求导致 ST 票据失效
   * 2) 刷新回调页或浏览器后退重复提交已消费 ticket 报错
   * 3) 第二次登录因用户已存在导致唯一键冲突或绑定失败
   */
  @Get('cas/callback')
  async handleCasCallback(
    @Req() req: Request,
    @Res() res: Response,
    @Query('ticket') ticket?: string,
  ) {
    const frontendBase = this.casService.getFrontendBaseUrl(req);
    const returnTo = this.casService.sanitizeReturnTo(
      req.cookies?.[appConfig.returnToCookieName],
    );
    const callbackUrl = this.casService.getCallbackUrl(req);

    res.clearCookie(appConfig.returnToCookieName, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.isSecureRequest(req),
      path: '/',
    });

    if (!ticket) {
      if (this.hasValidExistingSession(req)) {
        return res.redirect(302, `${frontendBase}${returnTo}`);
      }
      return res.redirect(
        302,
        `${frontendBase}/?authError=${encodeURIComponent('缺少 CAS ticket 票据参数，请重新发起登录')}`,
      );
    }

    const validateResult = await this.casService.validateCasTicket(ticket, callbackUrl);
    if (!validateResult.success) {
      // 如果浏览器在完成登录后误刷新了带旧 ticket 的回调 URL，但已持有有效会话，则直接平滑进入应用
      if (this.hasValidExistingSession(req)) {
        this.logger.warn(
          `Ignoring stale CAS ticket on callback because valid session cookie already exists`,
        );
        return res.redirect(302, `${frontendBase}${returnTo}`);
      }
      this.logger.error(`CAS callback validation failed: ${validateResult.message}`);
      return res.redirect(
        302,
        `${frontendBase}/?authError=${encodeURIComponent(validateResult.message)}`,
      );
    }

    const user = this.casService.upsertUserFromCas(validateResult.data.userInfo);
    const jwt = signSessionToken({
      uid: user.id,
      studentId: user.student_id,
      casUserId: user.cas_user_id,
      name: user.name,
      authProvider: 'dlufl-cas',
    });

    this.setSessionCookie(res, req, jwt);
    return res.redirect(302, `${frontendBase}${returnTo}`);
  }

  /**
   * 内网/备选 DES 加密登录令牌接口（参照 hydrooj-oauth-dlufl 的 LtTokenHandler）。
   */
  @Get('cas/token')
  async getIntranetToken(@Req() req: Request) {
    const callbackUrl = this.casService.getCallbackUrl(req);
    const result = await this.casService.getIntranetLoginTokens(callbackUrl);
    if (!result.success) {
      throw new BadRequestException(result.message);
    }
    return {
      success: true,
      ...result.data,
      callbackUrl,
    };
  }

  /**
   * 内网/备选登录提交接口：由服务端安全完成 CAS 协议编码并换取 ST 票据。
   */
  @Post('cas/submit')
  async submitIntranetLogin(
    @Body()
    body: {
      token?: string;
      execution?: string;
      username?: string;
      password?: string;
      rsa?: string;
      ul?: string | number;
      pl?: string | number;
    },
  ) {
    const hasPlain = Boolean(body?.username && body?.password);
    const hasPreEncoded = Boolean(body?.rsa && body?.ul && body?.pl);
    if (!body?.token || !body?.execution || (!hasPlain && !hasPreEncoded)) {
      throw new BadRequestException('缺少必要的 CAS 登录参数');
    }
    const result = await this.casService.submitIntranetLogin({
      token: String(body.token),
      execution: String(body.execution),
      username: body.username ? String(body.username) : undefined,
      password: body.password ? String(body.password) : undefined,
      rsa: body.rsa ? String(body.rsa) : undefined,
      ul: body.ul !== undefined ? String(body.ul) : undefined,
      pl: body.pl !== undefined ? String(body.pl) : undefined,
    });
    if (!result.success) {
      throw new BadRequestException(result.message);
    }
    return {
      success: true,
      ticket: result.data.ticket,
      redirectUrl: `/api/auth/cas/callback?ticket=${encodeURIComponent(result.data.ticket)}`,
    };
  }

  @UseGuards(OptionalAuthGuard)
  @Get('me')
  getMe(@Req() req: AuthenticatedRequest) {
    return {
      authenticated: Boolean(req.user),
      user: req.user ? this.casService.toPublicUser(req.user) : null,
      authProvider: req.authProvider || null,
      mockMode: appConfig.mockMode,
    };
  }

  /**
   * 退出登录：清理本地会话 Cookie，并返回 CAS 统一登出桥接地址。
   */
  @Post('logout')
  logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body?: { casLogout?: boolean },
  ) {
    this.clearSessionCookies(res, req);
    const frontendBase = this.casService.getFrontendBaseUrl(req);
    const isInternal = this.casService.isInternalNetwork(this.casService.getClientIp(req));
    const casLogoutUrl =
      body?.casLogout === false || isInternal
        ? null
        : this.casService.getCasLogoutUrl(frontendBase);

    return {
      success: true,
      casLogoutUrl,
    };
  }

  @Get('cas/logout')
  casUniLogout(@Req() req: Request, @Res() res: Response) {
    this.clearSessionCookies(res, req);
    const frontendBase = this.casService.getFrontendBaseUrl(req);
    const isInternal = this.casService.isInternalNetwork(this.casService.getClientIp(req));
    if (isInternal) {
      return res.redirect(302, frontendBase);
    }
    return res.redirect(302, this.casService.getCasLogoutUrl(frontendBase));
  }

  /**
   * 授权并验证图书馆 ICSpace 会话（用于实时查座、网页选座和 18:01 自动定时抢座）。
   */
  @UseGuards(AuthGuard)
  @Post('icspace/bind')
  async bindIcspace(
    @Req() req: AuthenticatedRequest,
    @Body() body: { password?: string },
  ) {
    const user = req.user!;
    if (!body?.password || !body.password.trim()) {
      throw new BadRequestException('请输入大外统一身份认证密码以完成图书馆预约授权');
    }
    const verifyRes = await this.icspService.bindUserCredentials(user, body.password.trim());
    return {
      success: true,
      message: '图书馆 ICSpace 预约授权成功，实时选座与 18:01 自动抢座已就绪',
      icspaceUser: verifyRes,
    };
  }

  @UseGuards(AuthGuard)
  @Delete('icspace/bind')
  unbindIcspace(@Req() req: AuthenticatedRequest) {
    this.icspService.unbindUserCredentials(req.user!.id);
    return {
      success: true,
      message: '已解除图书馆凭证绑定并清除服务端加密存储',
    };
  }

  /**
   * 仅在 ICSPACE_MOCK_MODE=true 时开放的离线演练登录入口（默认生产模式禁用）。
   */
  @Post('demo-login')
  demoLogin(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body?: { studentId?: string; name?: string; unitName?: string },
  ) {
    if (!appConfig.mockMode) {
      throw new ForbiddenException('演练模式未开启，请使用大外 CAS 统一身份认证登录');
    }
    const studentId = (body?.studentId || '2023041101').trim();
    const name = (body?.name || '林晓辰').trim();
    const unitName = (body?.unitName || '软件学院').trim();

    const user = this.casService.upsertUserFromCas({
      user_id: `demo_${studentId}`,
      id_number: studentId,
      user_name: name,
      unit_name: unitName,
      id_type: '1',
    });

    // 演练模式下自动标记 ICSpace 已绑定
    this.icspService.markMockBound(user.id);

    const jwt = signSessionToken({
      uid: user.id,
      studentId: user.student_id,
      casUserId: user.cas_user_id,
      name: user.name,
      authProvider: 'demo',
    });
    this.setSessionCookie(res, req, jwt);

    return {
      success: true,
      user: this.casService.toPublicUser(this.casService.findUserById(user.id)!),
    };
  }
}
