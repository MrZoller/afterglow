import { useState, type ReactNode } from 'react';
import { HELP, type Block, type HelpEntry } from '../help';
import { AlertIcon } from '../icons';
import { useSnap } from '../store';

/** Renders the few inline marks the help text uses: **bold**, `code` and [label](#/tab). */
function Inline({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(#\/[a-z]+\))/g);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith('**')) return <strong key={i}>{part.slice(2, -2)}</strong>;
        if (part.startsWith('`')) return <code key={i}>{part.slice(1, -1)}</code>;
        const link = /^\[([^\]]+)\]\((#\/[a-z]+)\)$/.exec(part);
        if (link) {
          return (
            <a key={i} href={link[2]}>
              {link[1]}
            </a>
          );
        }
        return part;
      })}
    </>
  );
}

function Answer({ blocks }: { blocks: Block[] }) {
  return (
    <div className="help-answer">
      {blocks.map((block, i) => {
        if (typeof block === 'string') {
          return (
            <p key={i}>
              <Inline text={block} />
            </p>
          );
        }
        const items = ('list' in block ? block.list : block.steps).map((item, j) => (
          <li key={j}>
            <Inline text={item} />
          </li>
        ));
        return 'list' in block ? <ul key={i}>{items}</ul> : <ol key={i}>{items}</ol>;
      })}
    </div>
  );
}

const plain = (text: string) => text.replace(/\*\*|`/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

/** Everything in an entry as lower-case text, for searching. */
function searchable(entry: HelpEntry): string {
  const blocks = entry.answer.flatMap((b) => (typeof b === 'string' ? [b] : 'list' in b ? b.list : b.steps));
  return plain([entry.question, ...blocks].join(' ')).toLowerCase();
}

const INDEX = HELP.map((topic) => ({ ...topic, entries: topic.entries.map((entry) => ({ entry, text: searchable(entry) })) }));

/** Setup steps this particular install has not finished, so the page starts with what matters here. */
function useOutstanding(): { text: ReactNode; key: string }[] {
  const { status, devices, settings } = useSnap();
  const out: { text: ReactNode; key: string }[] = [];
  if (status.mode === 'demo') {
    out.push({ key: 'demo', text: <Inline text="These are simulated lights. Put your Govee API key in the `.env` file as `GOVEE_API_KEY` and restart to control your own." /> });
  } else if (!status.connected) {
    out.push({ key: 'govee', text: `The app cannot reach Govee: ${status.error ?? 'unknown problem'}.` });
  }
  const far = devices.filter((d) => !d.local).length;
  if (status.lan.error) out.push({ key: 'lan', text: `Local control is unavailable: ${status.lan.error}.` });
  else if (status.lan.enabled && status.mode !== 'demo' && far > 0) {
    out.push({
      key: 'lan',
      text: <Inline text={`${far === devices.length ? 'None of your lights are' : `${far} of your ${devices.length} lights are not`} reached over your own network yet. Turn on **LAN Control** for ${far === 1 ? 'it' : 'them'} in the Govee Home app to make ${far === 1 ? 'it' : 'them'} respond instantly.`} />,
    });
  }
  if (!settings.location) out.push({ key: 'location', text: <Inline text="Add your location in [Settings](#/settings) so schedules can use sunrise and sunset." /> });
  if (status.notify.error && !status.notify.enabled) out.push({ key: 'notify', text: `Phone notifications are not working: ${status.notify.error}.` });
  else if (!status.notify.enabled) {
    out.push({ key: 'notify', text: <Inline text="Phone notifications are not set up, so a light that stays on after a schedule is only reported in the app. See “How do I get told on my phone when something goes wrong?” under **Schedules**." /> });
  }
  return out;
}

export function HelpView() {
  const [query, setQuery] = useState('');
  const outstanding = useOutstanding();
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const searching = words.length > 0;
  const topics = INDEX.map((topic) => ({ ...topic, entries: topic.entries.filter(({ text }) => words.every((w) => text.includes(w))) })).filter((topic) => topic.entries.length > 0);

  return (
    <>
      <header className="page-head">
        <h1>Help</h1>
      </header>

      <div className="help">
        <input className="input" type="search" placeholder="Search help" aria-label="Search help" value={query} onChange={(e) => setQuery(e.target.value)} />

        {!searching && outstanding.length > 0 && (
          <section className="card help-todo">
            <h2>Still to set up</h2>
            <ul>
              {outstanding.map((item) => (
                <li key={item.key}>
                  <AlertIcon size={16} />
                  <span>{item.text}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {topics.length === 0 && <p className="muted">Nothing in the help matches “{query}”. Try a different word, such as “schedule” or “joined”.</p>}

        {topics.map((topic) => (
          <section key={topic.title} className="card help-topic">
            <h2>{topic.title}</h2>
            {topic.entries.map(({ entry }) => (
              // While searching, matches are shown opened so the answer can be read without tapping each one.
              <details key={entry.question} open={searching ? true : undefined}>
                <summary>{entry.question}</summary>
                <Answer blocks={entry.answer} />
              </details>
            ))}
          </section>
        ))}
      </div>
    </>
  );
}
