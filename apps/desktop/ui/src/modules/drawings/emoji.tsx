import { useMemo, useState } from 'react';

/** [glyph, search keywords] — common trading / chart-annotation emojis. */
export const EMOJIS: [string, string][] = [
  ['⭐', 'star favorite'],
  ['🔥', 'fire hot momentum'],
  ['🚀', 'rocket moon pump breakout'],
  ['📈', 'chart up rise bull uptrend'],
  ['📉', 'chart down fall bear downtrend'],
  ['💰', 'money bag profit'],
  ['💵', 'dollar cash'],
  ['💎', 'diamond hands gem'],
  ['🐂', 'bull long buy'],
  ['🐻', 'bear short sell'],
  ['🎯', 'target goal tp'],
  ['🛑', 'stop sign sl'],
  ['⛔', 'no entry forbidden'],
  ['✅', 'check done yes ok'],
  ['❌', 'cross no wrong x'],
  ['⚠️', 'warning caution alert'],
  ['❗', 'exclamation important'],
  ['❓', 'question unsure'],
  ['👀', 'eyes watch look'],
  ['👍', 'thumbs up good'],
  ['👎', 'thumbs down bad'],
  ['🔔', 'bell alert notify'],
  ['🔒', 'lock secured'],
  ['🔓', 'unlock open'],
  ['⏰', 'alarm clock time'],
  ['⌛', 'hourglass wait'],
  ['📌', 'pin mark'],
  ['📍', 'pushpin location'],
  ['🏁', 'flag finish end'],
  ['🚩', 'red flag warning'],
  ['🟢', 'green circle buy up'],
  ['🔴', 'red circle sell down'],
  ['🟡', 'yellow circle wait'],
  ['🔵', 'blue circle info'],
  ['⚪', 'white circle'],
  ['⚫', 'black circle'],
  ['🟩', 'green square'],
  ['🟥', 'red square'],
  ['🟨', 'yellow square'],
  ['🟦', 'blue square'],
  ['⬆️', 'arrow up'],
  ['⬇️', 'arrow down'],
  ['↗️', 'arrow up right'],
  ['↘️', 'arrow down right'],
  ['🔄', 'reverse cycle repeat'],
  ['💥', 'boom explosion spike'],
  ['⚡', 'lightning fast volatility'],
  ['🌊', 'wave flow'],
  ['🧲', 'magnet magnetic'],
  ['🧠', 'brain idea think'],
  ['💡', 'idea bulb'],
  ['🔍', 'search zoom inspect'],
  ['🏆', 'trophy win'],
  ['🥇', 'gold medal first'],
  ['👑', 'crown king'],
  ['🎲', 'dice gamble risk'],
  ['🛡️', 'shield defend support'],
  ['⚔️', 'swords fight battle'],
  ['🐋', 'whale big player'],
  ['🦈', 'shark'],
  ['🐳', 'whale blue'],
  ['🦅', 'eagle'],
  ['🐢', 'turtle slow'],
  ['🐇', 'rabbit fast'],
  ['🐺', 'wolf'],
  ['🦁', 'lion'],
  ['🌙', 'moon night'],
  ['☀️', 'sun day'],
  ['❄️', 'snow cold freeze'],
  ['☔', 'rain umbrella'],
  ['🌪️', 'tornado storm chaos'],
  ['💣', 'bomb danger'],
  ['🧨', 'firecracker dynamite'],
  ['🪙', 'coin'],
  ['🏦', 'bank'],
  ['📊', 'bar chart stats'],
  ['📋', 'clipboard list'],
  ['📝', 'note memo write'],
  ['📅', 'calendar date event'],
  ['📰', 'news paper'],
  ['🎤', 'microphone speech fed'],
  ['🇺🇸', 'usa us america'],
  ['🇪🇺', 'eu europe euro'],
  ['🇯🇵', 'japan yen'],
  ['🇬🇧', 'uk britain pound'],
  ['❤️', 'heart love'],
  ['💔', 'broken heart loss'],
  ['😀', 'smile happy'],
  ['😎', 'cool'],
  ['😱', 'shock scared'],
  ['😭', 'cry loss'],
  ['🤔', 'thinking hmm'],
  ['🙏', 'pray hope'],
];

/** Emojis matching the query (all words must appear in the glyph or its keywords). */
export function filterEmojis(query: string): [string, string][] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return EMOJIS;
  return EMOJIS.filter(([g, k]) => words.every((w) => g === w || k.includes(w)));
}

/** Emoji marker picker: search box + grid of common emojis + free text for any other glyph. */
export function EmojiPicker({ value, onPick }: { value: string; onPick: (glyph: string) => void }) {
  const [q, setQ] = useState('');
  const list = useMemo(() => filterEmojis(q), [q]);
  return (
    <div className="dr-emoji" data-testid="emoji-picker">
      <div className="row gap8">
        <input
          className="ht-input"
          aria-label="Search emoji"
          placeholder="Search emoji (fire, rocket, bull…)"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <input
          className="ht-input dr-emoji-custom"
          aria-label="Custom emoji"
          title="Type or paste any emoji"
          value={value}
          maxLength={8}
          onChange={(e) => e.target.value && onPick(e.target.value)}
        />
      </div>
      <div className="dr-emoji-grid" role="listbox" aria-label="Emoji">
        {list.map(([g, k]) => (
          <button
            key={g}
            role="option"
            aria-selected={g === value}
            aria-label={k.split(' ')[0]}
            title={k}
            className="dr-emoji-btn"
            onClick={() => onPick(g)}
          >
            {g}
          </button>
        ))}
        {!list.length && <div className="muted">No emoji matches “{q}”</div>}
      </div>
    </div>
  );
}
