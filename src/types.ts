export type DiceColor = 'white' | 'red' | 'yellow' | 'green' | 'blue'

export type Die = {
  id: string
  color: DiceColor
  value: number
}

export type RollEntry = {
  id: number
  dice: Die[]
  by: string // display name of whoever rolled ('' if unset)
}

export type Player = { id: string; name: string }

// Messages exchanged between peers over the data channel.
export type Message =
  | { type: 'roll'; by: string } // client -> host: roll on my behalf, attributed to `by`
  | { type: 'clear' } // client -> host: please clear history
  | { type: 'rolling' } // host -> clients: a roll started (animate)
  | { type: 'state'; dice: Die[]; history: RollEntry[] } // host -> clients: authoritative dice/history
  | { type: 'hello'; id: string; name: string } // client -> host: my identity + name
  | { type: 'roster'; players: Player[] } // host -> clients: who's in the room
