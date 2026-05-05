import { useState } from 'react'
import { CodeBracketIcon } from '@heroicons/react/24/outline'

const FUNCTION_DOCS = [
  {
    sig: 'get_default_params() -> dict',
    desc: 'Return a dict of default parameter values. These are passed as keyword arguments to generate_signals when no overrides are provided.',
    optional: true,
  },
  {
    sig: 'generate_signals(df: pd.DataFrame, **params) -> pd.DataFrame',
    desc: 'Core signal generation function. Receives OHLCV data (columns: Open, High, Low, Close, Volume) and must return the DataFrame with a "signal" column added: +1 = buy, -1 = sell, 0 = hold.',
    optional: false,
  },
]

export default function FunctionReference() {
  const [open, setOpen] = useState(false)
  return (
    <>
      {/* Collapsed tab — rotated label anchored to bottom of content area */}
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="fixed z-50 flex items-center gap-1 py-0.5 px-2 bg-dark-900 border border-dark-500 rounded-l-lg text-[11px] font-semibold text-slate-500 hover:text-slate-300 hover:bg-dark-800 transition-colors shadow-lg"
          style={{
            bottom: '32px',
            left: '3rem',
            writingMode: 'vertical-rl',
            transform: 'rotate(180deg)',
            transformOrigin: 'center center',
          }}
          title="Show Overridable Functions reference"
        >
          <CodeBracketIcon className="h-3 w-3" style={{ transform: 'rotate(180deg)' }} />
          Overridable Functions
        </button>
      )}

      {/* Expanded panel — floats over content */}
      {open && (
        <div className="fixed z-50 w-80 bg-dark-800 border border-dark-500 rounded-tr-xl shadow-2xl" style={{ bottom: '32px', left: '3rem' }}>
          <div className="flex items-center justify-between px-4 py-3 border-b border-dark-500">
            <h3 className="font-semibold text-slate-200 text-sm uppercase tracking-wider">
              Overridable Functions
            </h3>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-slate-500 hover:text-slate-300 transition-colors text-xs"
            >
              ✕ close
            </button>
          </div>
          <div className="p-4 space-y-3 max-h-[60vh] overflow-y-auto">
            {FUNCTION_DOCS.map((fn) => (
              <div key={fn.sig} className="bg-dark-900/60 border border-dark-500 rounded-lg p-3 space-y-1.5">
                <div className="flex items-center gap-2">
                  <CodeBracketIcon className="h-4 w-4 text-emerald-400 flex-shrink-0" />
                  <code className="text-xs text-emerald-300 font-mono break-all">{fn.sig}</code>
                </div>
                <p className="text-xs text-slate-400 leading-relaxed">{fn.desc}</p>
                {fn.optional ? (
                  <span className="inline-block text-[10px] px-1.5 py-0.5 rounded bg-slate-700/60 text-slate-400">
                    optional
                  </span>
                ) : (
                  <span className="inline-block text-[10px] px-1.5 py-0.5 rounded bg-emerald-900/40 text-emerald-400 border border-emerald-700/30">
                    required
                  </span>
                )}
              </div>
            ))}
            <div className="bg-dark-900/60 border border-dark-500 rounded-lg p-3 space-y-1.5">
              <div className="text-xs text-slate-400 font-semibold uppercase tracking-wide">
                Allowed imports
              </div>
              <div className="flex flex-wrap gap-1.5 mt-1">
                {['pandas (pd)', 'numpy (np)', 'math', 'statistics'].map(m => (
                  <code key={m} className="text-xs bg-dark-700 text-slate-300 px-1.5 py-0.5 rounded font-mono">
                    {m}
                  </code>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
