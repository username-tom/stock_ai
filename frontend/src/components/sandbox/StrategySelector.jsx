import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronDownIcon, CodeBracketIcon } from '@heroicons/react/24/outline'
import { getStrategies, getScripts } from '../../api/client'
import { CUSTOM_SCRIPT_KEY, STRATEGY_PARAM_UI } from './sandboxConstants'
import { stratLabel, defaultParams } from './sandboxHelpers'

export default function StrategySelector({ value, scriptId, onStrategyChange, onScriptChange, stratParams, onParamChange }) {
  const { data: stratData, isLoading: stratLoading } = useQuery({ queryKey: ['strategies'], queryFn: getStrategies })
  const { data: scriptsData, isLoading: scriptsLoading } = useQuery({ queryKey: ['scripts'], queryFn: getScripts })
  const [editorOpen, setEditorOpen] = useState(false)
  const [scriptText, setScriptText] = useState('')
  const isCustom = value === CUSTOM_SCRIPT_KEY
  const scripts = scriptsData?.scripts ?? []
  const paramFields = isCustom ? [] : (STRATEGY_PARAM_UI[value] || [])
  const strategies = stratData?.strategies ?? []
  const selectedStrategy = strategies.find(s => s.type === value)
  const selectedScript = isCustom ? scripts.find(s => s.id === scriptId) : null

  return (
    <div className="space-y-3">
      <div>
        <label className="label">Strategy</label>
        {stratLoading
          ? <div className="input animate-pulse bg-dark-700 text-transparent">Loading</div>
          : <select className="input" value={value} onChange={e => onStrategyChange(e.target.value)}>
              {strategies.map(s => <option key={s.type} value={s.type}>{stratLabel(s.type)}</option>)}
              <option value={CUSTOM_SCRIPT_KEY}>⚙ Custom Script</option>
            </select>
        }
        {selectedStrategy?.description && (
          <p className="mt-1.5 text-xs text-slate-500 leading-relaxed">{selectedStrategy.description}</p>
        )}
      </div>

      {isCustom && (
        <div className="border border-dark-500 rounded-lg overflow-hidden bg-dark-900/30">
          <div className="flex items-center gap-1.5 px-3 py-2 text-xs text-slate-400 uppercase tracking-wider border-b border-dark-600">
            <CodeBracketIcon className="h-3.5 w-3.5" />Custom Script
          </div>
          <div className="p-3 space-y-2">
            {scriptsLoading ? <div className="h-8 bg-dark-700 rounded animate-pulse" />
              : scripts.length === 0 ? <div className="text-xs text-amber-400/80">No scripts saved yet. Create one in the Scripts tab.</div>
              : <>
                  <select className="input" value={scriptId ?? ''} onChange={e => {
                    const id = e.target.value ? parseInt(e.target.value, 10) : null
                    onScriptChange(id)
                    const sc = scripts.find(s => s.id === id)
                    setScriptText(sc?.script_code || '')
                    setEditorOpen(false)
                  }}>
                    <option value="">— choose a script —</option>
                    {scripts.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                  {selectedScript && (
                    <>
                      {selectedScript.description && (
                        <p className="text-xs text-slate-500 leading-relaxed">{selectedScript.description}</p>
                      )}
                      <button
                        type="button"
                        className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 transition-colors w-full text-left"
                        onClick={() => { setEditorOpen(v => !v); if (!editorOpen) setScriptText(selectedScript.script_code || '') }}
                      >
                        <ChevronDownIcon className={`h-3.5 w-3.5 transition-transform ${editorOpen ? 'rotate-180' : ''}`} />
                        {editorOpen ? 'Hide' : 'View / Edit'} script
                      </button>
                      {editorOpen && (
                        <textarea
                          className="w-full h-64 font-mono text-xs bg-dark-950 border border-dark-500 rounded-lg p-3 text-slate-300 resize-y focus:outline-none focus:ring-1 focus:ring-emerald-600/50"
                          value={scriptText}
                          onChange={e => setScriptText(e.target.value)}
                          spellCheck={false}
                        />
                      )}
                    </>
                  )}
                </>
            }
          </div>
        </div>
      )}

      {!isCustom && paramFields.length > 0 && (
        <div className="border border-dark-500 rounded-lg p-3 space-y-2 bg-dark-900/30">
          <div className="text-xs text-slate-500 uppercase tracking-wider">Strategy Parameters</div>
          {paramFields.map(f => (
            <div key={f.key}>
              <label className="label">{f.label}</label>
              {f.type === 'select'
                ? <select className="input" value={stratParams[f.key] ?? f.default} onChange={e => onParamChange(f.key, e.target.value)}>
                    {f.options.map(o => <option key={o}>{o}</option>)}
                  </select>
                : <input className="input" type="number" step={f.step ?? 1} value={stratParams[f.key] ?? f.default}
                    onChange={e => onParamChange(f.key, f.step ? parseFloat(e.target.value) : parseInt(e.target.value, 10))} />
              }
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
