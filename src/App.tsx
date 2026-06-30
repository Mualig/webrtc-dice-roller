import { useCallback, useEffect, useRef, useState } from 'react'
import { usePeerSync } from './usePeerSync'

type DiceColor = 'white' | 'red' | 'yellow' | 'green' | 'blue'

type Die = {
  id: string
  color: DiceColor
  value: number
}

type RollEntry = {
  id: number
  dice: Die[]
  by: string // display name of whoever rolled ('' if unset)
}

type Player = { id: string; name: string }

// Messages exchanged between peers over the data channel.
type Message =
  | { type: 'roll'; by: string } // client -> host: roll on my behalf, attributed to `by`
  | { type: 'clear' } // client -> host: please clear history
  | { type: 'rolling' } // host -> clients: a roll started (animate)
  | { type: 'state'; dice: Die[]; history: RollEntry[] } // host -> clients: authoritative dice/history
  | { type: 'hello'; id: string; name: string } // client -> host: my identity + name
  | { type: 'roster'; players: Player[] } // host -> clients: who's in the room

const DICE: { id: string; color: DiceColor }[] = [
  { id: 'white-1', color: 'white' },
  { id: 'white-2', color: 'white' },
  { id: 'red', color: 'red' },
  { id: 'yellow', color: 'yellow' },
  { id: 'green', color: 'green' },
  { id: 'blue', color: 'blue' },
]

const COLOR_STYLES: Record<
  DiceColor,
  { face: string; pip: string; text: string }
> = {
  white: { face: 'bg-white border border-zinc-300', pip: 'bg-zinc-800', text: 'text-zinc-800' },
  red: { face: 'bg-red-500', pip: 'bg-white', text: 'text-white' },
  yellow: { face: 'bg-yellow-400', pip: 'bg-white', text: 'text-white' },
  green: { face: 'bg-green-600', pip: 'bg-white', text: 'text-white' },
  blue: { face: 'bg-blue-600', pip: 'bg-white', text: 'text-white' },
}

// Which of the 9 grid cells are filled for each die value (1-6).
const PIP_LAYOUT: Record<number, number[]> = {
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
}

function rollValue() {
  return Math.floor(Math.random() * 6) + 1
}

// Roster + identity helpers.
const NAME_KEY = 'qwixx-player-name'

function displayName(raw: string) {
  return raw.trim() || 'Anonymous'
}

function upsertPlayer(list: Player[], id: string, name: string): Player[] {
  return list.some((p) => p.id === id)
    ? list.map((p) => (p.id === id ? { id, name } : p))
    : [...list, { id, name }]
}

function Dice({ die, rolling }: Readonly<{ die: Die; rolling: boolean }>) {
  const styles = COLOR_STYLES[die.color]
  return (
    <div className="flex flex-col items-center gap-2">
      <div
        className={`grid h-20 w-20 grid-cols-3 grid-rows-3 gap-1 rounded-2xl p-2.5 shadow-lg transition-transform ${
          styles.face
        } ${rolling ? 'animate-spin' : ''}`}
      >
        {Array.from({ length: 9 }, (_, cell) => (
          <div key={cell} className="flex items-center justify-center">
            {PIP_LAYOUT[die.value].includes(cell) && (
              <span className={`h-3 w-3 rounded-full ${styles.pip}`} />
            )}
          </div>
        ))}
      </div>
      <span className="text-sm font-medium capitalize text-zinc-500">
        {die.color}
      </span>
    </div>
  )
}

function HistoryEntry({ entry, label }: Readonly<{ entry: RollEntry; label: number }>) {
  return (
    <li className="flex items-center gap-3 rounded-lg bg-zinc-50 px-3 py-2">
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
      {entry.by && (
        <span className="shrink-0 text-sm font-medium text-zinc-500">
          {entry.by}
        </span>
      )}
    </li>
  )
}

function NameField({
  name,
  onChange,
}: Readonly<{ name: string; onChange: (value: string) => void }>) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-zinc-400">
        Your name
      </span>
      <input
        value={name}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Enter your name"
        maxLength={20}
        className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-zinc-900"
      />
    </label>
  )
}

function Roster({ players, selfId }: Readonly<{ players: Player[]; selfId: string | null }>) {
  if (players.length === 0) return null
  return (
    <ul className="mt-3 flex flex-wrap gap-2">
      {players.map((player) => (
        <li
          key={player.id}
          className="flex items-center gap-1.5 rounded-full bg-zinc-100 px-3 py-1 text-sm text-zinc-700"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
          {displayName(player.name)}
          {player.id === selfId && <span className="text-zinc-400">(you)</span>}
        </li>
      ))}
    </ul>
  )
}

function LeaveButton({ onLeave }: Readonly<{ onLeave: () => void }>) {
  return (
    <button
      type="button"
      onClick={onLeave}
      className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-600 transition hover:bg-zinc-100"
    >
      Leave
    </button>
  )
}

function ConnectionPanel({
  role,
  status,
  roomCode,
  peerCount,
  players,
  selfId,
  error,
  shareLink,
  copied,
  onCreate,
  onJoin,
  onLeave,
  onCopy,
}: Readonly<{
  role: ReturnType<typeof usePeerSync>['role']
  status: ReturnType<typeof usePeerSync>['status']
  roomCode: string | null
  peerCount: number
  players: Player[]
  selfId: string | null
  error: string | null
  shareLink: string
  copied: boolean
  onCreate: () => void
  onJoin: (code: string) => void
  onLeave: () => void
  onCopy: () => void
}>) {
  const [codeInput, setCodeInput] = useState('')

  if (status === 'connecting') {
    return (
      <div className="rounded-xl border border-zinc-200 bg-white p-4 text-center">
        <p className="text-sm text-zinc-600">
          {role === 'host' ? 'Creating room…' : 'Connecting to room…'}
        </p>
        <button
          type="button"
          onClick={onLeave}
          className="mt-2 text-sm font-medium text-zinc-500 transition hover:text-zinc-900"
        >
          Cancel
        </button>
      </div>
    )
  }

  if (status === 'connected' && role === 'host') {
    return (
      <div className="rounded-xl border border-zinc-200 bg-white p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-zinc-400">
              Room code
            </p>
            <p className="font-mono text-2xl font-bold tracking-widest text-zinc-900">
              {roomCode}
            </p>
          </div>
          <span className="flex items-center gap-1.5 text-sm text-zinc-500">
            <span className="h-2 w-2 rounded-full bg-green-500" />
            {peerCount === 0
              ? 'Waiting for players'
              : `${peerCount} ${peerCount === 1 ? 'player' : 'players'} joined`}
          </span>
        </div>
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={onCopy}
            className="flex-1 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-zinc-700"
          >
            {copied ? 'Link copied!' : 'Copy invite link'}
          </button>
          <LeaveButton onLeave={onLeave} />
        </div>
        <p className="mt-2 truncate text-xs text-zinc-400">{shareLink}</p>
        <Roster players={players} selfId={selfId} />
      </div>
    )
  }

  if (status === 'connected' && role === 'client') {
    return (
      <div className="rounded-xl border border-zinc-200 bg-white p-4">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-2 text-sm text-zinc-600">
            <span className="h-2 w-2 rounded-full bg-green-500" />
            Connected to room{' '}
            <span className="font-mono font-bold tracking-widest text-zinc-900">
              {roomCode}
            </span>
          </span>
          <LeaveButton onLeave={onLeave} />
        </div>
        <Roster players={players} selfId={selfId} />
      </div>
    )
  }

  // Solo / idle / error: the lobby.
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      <p className="text-sm font-semibold text-zinc-900">Play together</p>
      <p className="mt-0.5 text-sm text-zinc-500">
        Share live rolls with friends over a direct peer-to-peer connection.
      </p>
      <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center">
        <button
          type="button"
          onClick={onCreate}
          className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-zinc-700"
        >
          Create room
        </button>
        <span className="text-center text-xs uppercase text-zinc-400">or</span>
        <form
          className="flex flex-1 gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            onJoin(codeInput)
          }}
        >
          <input
            value={codeInput}
            onChange={(e) => setCodeInput(e.target.value.toUpperCase())}
            placeholder="Room code"
            maxLength={4}
            className="w-full rounded-lg border border-zinc-300 px-3 py-2 font-mono text-sm tracking-widest uppercase outline-none focus:border-zinc-900"
          />
          <button
            type="submit"
            className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition hover:bg-zinc-100"
          >
            Join
          </button>
        </form>
      </div>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  )
}

function App() {
  const [dice, setDice] = useState<Die[]>(() =>
    DICE.map((d) => ({ ...d, value: rollValue() })),
  )
  const [history, setHistory] = useState<RollEntry[]>([])
  const [rolling, setRolling] = useState(false)
  const [copied, setCopied] = useState(false)
  const [name, setName] = useState(() => localStorage.getItem(NAME_KEY) ?? '')
  const [players, setPlayers] = useState<Player[]>([])
  const nextId = useRef(1)

  // Refs mirror the latest dice/history/roster so PeerJS event handlers and the
  // delayed roll callback read current values instead of stale closures.
  const diceRef = useRef(dice)
  const historyRef = useRef(history)
  const playersRef = useRef(players)

  // `handleMessage`/`handleClientJoin`/`handleClientLeave` are hoisted and only
  // ever invoked after render (on a peer event), so passing them straight through
  // is safe — and usePeerSync already keeps its own latest-callback refs, so
  // PeerJS always calls the freshest closure (with current `role`/`send`).
  const { role, status, roomCode, peerCount, peerId, error, createRoom, joinRoom, leave, send } =
    usePeerSync({
      onMessage: handleMessage,
      onClientJoin: handleClientJoin,
      onClientLeave: handleClientLeave,
    })

  const myName = name.trim()

  // Commit new dice/history locally. The host is authoritative, so every state
  // change is broadcast to clients from this single point.
  function applyState(nextDice: Die[], nextHistory: RollEntry[]) {
    diceRef.current = nextDice
    historyRef.current = nextHistory
    setDice(nextDice)
    setHistory(nextHistory)
    if (role === 'host') {
      send({ type: 'state', dice: nextDice, history: nextHistory } satisfies Message)
    }
  }

  // Commit the roster locally; the host (authoritative for presence) broadcasts
  // it. Memoized so the host self-entry effect can depend on it without churn.
  const updateRoster = useCallback(
    (nextPlayers: Player[]) => {
      playersRef.current = nextPlayers
      setPlayers(nextPlayers)
      if (role === 'host') {
        send({ type: 'roster', players: nextPlayers } satisfies Message)
      }
    },
    [role, send],
  )

  // Generate a roll locally and (if hosting) broadcast it. Only ever runs on
  // the authoritative peer — solo or host. `by` attributes it to a player.
  function performRoll(by: string) {
    setRolling(true)
    if (role === 'host') send({ type: 'rolling' } satisfies Message)
    setTimeout(() => {
      const rolled = DICE.map((d) => ({ ...d, value: rollValue() }))
      const nextHistory: RollEntry[] = [
        { id: nextId.current++, dice: rolled, by },
        ...historyRef.current,
      ]
      applyState(rolled, nextHistory)
      setRolling(false)
    }, 500)
  }

  function roll() {
    if (status === 'connecting') return
    if (role === 'client') {
      send({ type: 'roll', by: myName } satisfies Message)
      return
    }
    performRoll(myName)
  }

  function clearHistory() {
    if (role === 'client') {
      send({ type: 'clear' } satisfies Message)
      return
    }
    applyState(diceRef.current, [])
  }

  function handleMessage(msg: unknown) {
    const m = msg as Message
    if (role === 'host') {
      if (m.type === 'roll') performRoll(m.by)
      else if (m.type === 'clear') clearHistory()
      else if (m.type === 'hello') {
        // We key the roster on the client's self-reported id, which PeerJS
        // guarantees equals the transport's `conn.peer` — so handleClientLeave
        // (which only has `conn.peer`) can later remove this same entry.
        updateRoster(upsertPlayer(playersRef.current, m.id, m.name))
      }
    } else if (role === 'client') {
      if (m.type === 'rolling') setRolling(true)
      else if (m.type === 'state') {
        setRolling(false)
        applyState(m.dice, m.history)
      } else if (m.type === 'roster') {
        updateRoster(m.players)
      }
    }
  }

  // Host: bring a newly-connected client up to date with current state + roster.
  function handleClientJoin() {
    send({ type: 'state', dice: diceRef.current, history: historyRef.current } satisfies Message)
    send({ type: 'roster', players: playersRef.current } satisfies Message)
  }

  // Host: drop a disconnected client from the roster.
  function handleClientLeave(id: string) {
    updateRoster(playersRef.current.filter((player) => player.id !== id))
  }

  // Auto-join when opened via a shared ?room=CODE link.
  const didInit = useRef(false)
  useEffect(() => {
    if (didInit.current) return
    didInit.current = true
    const code = new URLSearchParams(window.location.search).get('room')
    if (code) joinRoom(code)
  }, [joinRoom])

  // Persist the player's name across sessions.
  useEffect(() => {
    localStorage.setItem(NAME_KEY, name)
  }, [name])

  // Host: keep our own roster entry (keyed by our peer id) in sync with our name.
  useEffect(() => {
    if (role !== 'host' || status !== 'connected' || !peerId) return
    updateRoster(upsertPlayer(playersRef.current, peerId, myName))
  }, [role, status, peerId, myName, updateRoster])

  // Client: announce our identity + name on connect and whenever it changes.
  useEffect(() => {
    if (role === 'client' && status === 'connected' && peerId) {
      send({ type: 'hello', id: peerId, name: myName } satisfies Message)
    }
  }, [role, status, peerId, myName, send])

  const shareLink = roomCode
    ? `${window.location.origin}${window.location.pathname}?room=${roomCode}`
    : ''

  function copyLink() {
    navigator.clipboard.writeText(shareLink).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  // Reset presence when (re)starting or leaving a session, so stale players from
  // a previous room never linger into the next one.
  function resetRoster() {
    playersRef.current = []
    setPlayers([])
  }
  function startHosting() {
    resetRoster()
    createRoom()
  }
  function startJoining(code: string) {
    resetRoster()
    joinRoom(code)
  }
  function leaveRoom() {
    resetRoster()
    leave()
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-10 bg-zinc-100 px-6 py-12">
      <header className="text-center">
        <h1 className="text-4xl font-bold tracking-tight text-zinc-900">
          Qwixx Dice
        </h1>
        <p className="mt-2 text-zinc-500">
          Roll all six dice: 2 white, red, yellow, green &amp; blue
        </p>
      </header>

      <section className="flex w-full max-w-md flex-col gap-4">
        <NameField name={name} onChange={setName} />
        <ConnectionPanel
          role={role}
          status={status}
          roomCode={roomCode}
          peerCount={peerCount}
          players={players}
          selfId={peerId}
          error={error}
          shareLink={shareLink}
          copied={copied}
          onCreate={startHosting}
          onJoin={startJoining}
          onLeave={leaveRoom}
          onCopy={copyLink}
        />
      </section>

      <section className="grid grid-cols-3 gap-6 sm:grid-cols-6">
        {dice.map((die) => (
          <Dice key={die.id} die={die} rolling={rolling} />
        ))}
      </section>

      <div className="flex flex-col items-center gap-4">
        <button
          type="button"
          onClick={roll}
          disabled={rolling || status === 'connecting'}
          className="rounded-full bg-zinc-900 px-8 py-3 text-lg font-semibold text-white shadow-md transition hover:bg-zinc-700 active:scale-95 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {rolling ? 'Rolling…' : 'Roll dice'}
        </button>
      </div>

      <section className="w-full max-w-md">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-zinc-900">History</h2>
          {history.length > 0 && (
            <button
              type="button"
              onClick={clearHistory}
              className="text-sm font-medium text-zinc-500 transition hover:text-zinc-900"
            >
              Clear
            </button>
          )}
        </div>
        {history.length === 0 ? (
          <p className="rounded-lg border border-dashed border-zinc-300 px-4 py-6 text-center text-sm text-zinc-400">
            No rolls yet — hit “Roll dice” to get started.
          </p>
        ) : (
          <ul className="flex max-h-80 flex-col gap-2 overflow-y-auto pr-1">
            {history.map((entry, index) => (
              <HistoryEntry
                key={entry.id}
                entry={entry}
                label={history.length - index}
              />
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}

export default App
