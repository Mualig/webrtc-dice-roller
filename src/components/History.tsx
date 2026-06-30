import type { RollEntry } from '../types'
import { COLOR_STYLES } from '../dice'

export function HistoryEntry({
  entry,
  label,
  color,
}: Readonly<{ entry: RollEntry; label: number; color: string }>) {
  return (
    <li
      style={{ borderColor: color || 'transparent' }}
      className="flex items-center gap-3 rounded-lg border-2 bg-zinc-50 px-3 py-2"
    >
      <span className="w-8 shrink-0 text-sm font-medium text-zinc-400">
        #{label}
      </span>
      <div className="flex flex-1 flex-wrap gap-1.5">
        {entry.dice.map((die) => {
          const styles = COLOR_STYLES[die.color]
          return (
            <span
              key={die.id}
              className={`flex h-7 w-7 items-center justify-center rounded-md text-sm font-bold ${styles.face} ${styles.text}`}
            >
              {die.value}
            </span>
          )
        })}
      </div>
      {entry.roller.name && (
        <span className="shrink-0 text-sm font-medium text-zinc-500">
          {entry.roller.name}
        </span>
      )}
    </li>
  )
}
