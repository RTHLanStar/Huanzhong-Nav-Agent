import { useId } from 'react';
import { Text } from '@mantine/core';
import { formatShortDate } from '../../lib/format';

export function TrendChart({
  data,
  height = 120,
}: {
  data: { date: string; total: number }[];
  height?: number;
}) {
  const gradientId = useId().replace(/:/g, '');
  const width = 640;
  const max = Math.max(1, ...data.map((item) => item.total));
  const step = data.length > 1 ? width / (data.length - 1) : width;
  const points = data.map((item, index) => {
    const x = index * step;
    const y = height - 14 - (item.total / max) * (height - 30);
    return [x, y] as const;
  });
  const line = points.map(([x, y], index) => `${index ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const area = `${line} L${width} ${height} L0 ${height} Z`;

  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} preserveAspectRatio="none">
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((ratio) => (
          <line
            key={ratio}
            x1={0}
            x2={width}
            y1={height * ratio}
            y2={height * ratio}
            stroke="var(--line)"
            strokeDasharray="4 4"
          />
        ))}
        <path d={area} fill={`url(#${gradientId})`} />
        <path d={line} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {points.map(([x, y], index) => (
          <circle key={index} cx={x} cy={y} r={2.4} fill="var(--accent)">
            <title>{`${data[index].date}：${data[index].total}`}</title>
          </circle>
        ))}
      </svg>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--txt-2)' }}>
        <span>{data[0] ? formatShortDate(data[0].date) : ''}</span>
        <span>峰值 {max}</span>
        <span>{data[data.length - 1] ? formatShortDate(data[data.length - 1].date) : ''}</span>
      </div>
    </div>
  );
}

export function Heatmap({ data }: { data: { date: string; hours: number[] }[] }) {
  const max = Math.max(1, ...data.flatMap((day) => day.hours));
  return (
    <div style={{ overflowX: 'auto' }}>
      <div style={{ minWidth: 560 }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '52px repeat(24, minmax(12px, 1fr))',
            gap: 2,
            alignItems: 'center',
          }}
        >
          <span />
          {Array.from({ length: 24 }, (_, hour) => (
            <Text key={hour} size="xs" c="dimmed" ta="center" style={{ fontSize: 9 }}>
              {hour % 3 === 0 ? hour : ''}
            </Text>
          ))}
          {data.map((day) => (
            <div key={day.date} style={{ display: 'contents' }}>
              <Text size="xs" c="dimmed" style={{ fontSize: 10 }}>
                {formatShortDate(day.date)}
              </Text>
              {day.hours.map((value, hour) => {
                const intensity = value / max;
                return (
                  <div
                    key={hour}
                    title={`${day.date} ${String(hour).padStart(2, '0')}:00 · ${value} 次`}
                    style={{
                      height: 16,
                      borderRadius: 3,
                      background:
                        value === 0
                          ? 'var(--surface-2)'
                          : `color-mix(in srgb, var(--accent) ${Math.max(12, Math.round(intensity * 100))}%, transparent)`,
                    }}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
