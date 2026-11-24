import React, { useEffect, useState } from 'react';
import type { LibraryArea, SeatInfo } from '../types';

// SPA 内存级底图 Blob 缓存：即使 Nginx 对 /api/ 加了 no-store，同会话内切换区域/切页也 0ms 秒开，不重复下载大图
const floorPlanBlobCache = new Map<string, string>();
const floorPlanPending = new Map<string, Promise<string | null>>();

function fetchFloorPlanCached(url: string): Promise<string | null> {
  const hit = floorPlanBlobCache.get(url);
  if (hit) return Promise.resolve(hit);

  const pending = floorPlanPending.get(url);
  if (pending) return pending;

  const task = fetch(url, { credentials: 'include' })
    .then(async (resp) => {
      if (!resp.ok) return null;
      const blob = await resp.blob();
      const objUrl = URL.createObjectURL(blob);
      floorPlanBlobCache.set(url, objUrl);
      return objUrl;
    })
    .catch(() => null)
    .finally(() => {
      floorPlanPending.delete(url);
    });

  floorPlanPending.set(url, task);
  return task;
}

interface SeatFloorMapProps {
  areaName: string;
  floorPlanUrl: string | null;
  areas: LibraryArea[];
  seats: SeatInfo[];
  matchedSeatIds: Set<string>;
  selectedDevId: string | null;
  mapZoom: number;
  onSelectSeat: (seat: SeatInfo) => void;
}

export const SeatFloorMap: React.FC<SeatFloorMapProps> = React.memo(
  ({
    areaName,
    floorPlanUrl,
    areas,
    seats,
    matchedSeatIds,
    selectedDevId,
    mapZoom,
    onSelectSeat,
  }) => {
    const [imgSrc, setImgSrc] = useState<string | null>(() =>
      floorPlanUrl ? floorPlanBlobCache.get(floorPlanUrl) || null : null,
    );

    useEffect(() => {
      let active = true;
      if (!floorPlanUrl) {
        setImgSrc(null);
        return;
      }

      const cached = floorPlanBlobCache.get(floorPlanUrl);
      if (cached) {
        setImgSrc(cached);
      } else {
        setImgSrc(null);
        void fetchFloorPlanCached(floorPlanUrl).then((resolved) => {
          if (active) setImgSrc(resolved);
        });
      }

      // 空闲时后台静默预热其它区域的底图，切换阅览区零等待
      const idleTimer = window.setTimeout(() => {
        for (const a of areas) {
          const url = `/api/library/areas/${a.id}/floorplan`;
          if (url !== floorPlanUrl && !floorPlanBlobCache.has(url)) {
            void fetchFloorPlanCached(url);
          }
        }
      }, 1500);

      return () => {
        active = false;
        window.clearTimeout(idleTimer);
      };
    }, [floorPlanUrl, areas]);

    return (
      <div
        className="overflow-auto rounded-xl border border-[#DCE4EE] bg-[#F8FAFC]"
        style={{ contain: 'layout style paint' }}
      >
        <div
          style={{
            width: `${Math.round(mapZoom * 100)}%`,
            minWidth: '640px',
            willChange: 'width',
          }}
          className="relative mx-auto select-none"
        >
          {imgSrc ? (
            <img
              src={imgSrc}
              alt={`${areaName} 平面座位图`}
              draggable={false}
              decoding="async"
              className="block h-auto w-full"
            />
          ) : (
            <div
              className="aspect-[16/10] w-full"
              style={{
                backgroundImage: 'radial-gradient(circle, #cbd5e1 1px, transparent 1px)',
                backgroundSize: '20px 20px',
              }}
            />
          )}

          {seats.map((seat) => {
            if (seat.coordX === null || seat.coordY === null) return null;
            const isSelected = selectedDevId === seat.devId;
            const isMatched = matchedSeatIds.has(seat.devId);

            const dotClass =
              seat.status === 'free'
                ? 'border-emerald-700 bg-emerald-500 text-white hover:bg-emerald-600'
                : seat.status === 'partial'
                  ? 'border-amber-700 bg-amber-400 text-[#0D223D] hover:bg-amber-500'
                  : seat.status === 'unreleased'
                    ? 'border-dashed border-slate-400 bg-slate-200 text-slate-600'
                    : 'border-slate-400 bg-slate-300 text-slate-600';

            return (
              <button
                key={seat.devId}
                type="button"
                onClick={() => onSelectSeat(seat)}
                title={`${seat.devName} · ${
                  seat.status === 'free'
                    ? '全时段可约'
                    : seat.status === 'partial'
                      ? `部分时段可约 (${seat.longestFreeSlot?.startStr}-${seat.longestFreeSlot?.endStr})`
                      : seat.status === 'unreleased'
                        ? '未放座'
                        : '已满'
                }`}
                style={{
                  left: `${seat.coordX}%`,
                  top: `${seat.coordY}%`,
                  transform: isSelected
                    ? 'translate(-50%, -50%) scale(1.25)'
                    : 'translate(-50%, -50%)',
                }}
                className={`absolute flex h-5 min-w-5 items-center justify-center rounded-full border px-1 font-mono text-[9px] font-bold leading-none ${dotClass} ${
                  isSelected ? 'z-30 ring-2 ring-[#0D386B] ring-offset-1' : 'z-10'
                } ${isMatched ? 'opacity-100' : 'opacity-20'}`}
              >
                {seat.seatNumber}
              </button>
            );
          })}
        </div>
      </div>
    );
  },
);

SeatFloorMap.displayName = 'SeatFloorMap';
