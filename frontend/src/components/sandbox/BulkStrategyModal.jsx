import { RectangleGroupIcon, XMarkIcon } from '@heroicons/react/24/outline'
import { CUSTOM_SCRIPT_KEY, TEMPLATE_SCRIPT_KEY } from './sandboxConstants'
import { defaultParams } from './sandboxHelpers'
import StrategySelector from './StrategySelector'

export default function BulkStrategyModal({
  open,
  positionsCount,
  bulkStratType,
  bulkScriptId,
  bulkTemplateFilename,
  bulkStratParams,
  bulkStrategyMut,
  setBulkStratOpen,
  setBulkStratType,
  setBulkScriptId,
  setBulkTemplateFilename,
  setBulkStratParams,
  handleBulkStratApply,
}) {
  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-dark-800 border border-dark-600 rounded-2xl shadow-2xl w-full max-w-md mx-4 flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-dark-700">
          <div className="flex items-center gap-2">
            <RectangleGroupIcon className="h-5 w-5 text-sky-400" />
            <span className="font-semibold text-slate-100">Set Strategy for All Positions</span>
          </div>
          <button onClick={() => setBulkStratOpen(false)} className="text-slate-500 hover:text-slate-300 transition-colors">
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          <p className="text-xs text-slate-400 leading-relaxed">
            Choose a strategy below. It will be applied to <span className="text-slate-200 font-medium">all {positionsCount} position{positionsCount !== 1 ? 's' : ''}</span> in the sandbox, replacing any existing strategy assignment.
          </p>
          <StrategySelector
            value={bulkStratType}
            scriptId={bulkScriptId}
            templateFilename={bulkTemplateFilename}
            onStrategyChange={type => {
              setBulkStratType(type)
              if (type !== CUSTOM_SCRIPT_KEY && type !== TEMPLATE_SCRIPT_KEY) setBulkStratParams(defaultParams(type))
            }}
            onScriptChange={id => setBulkScriptId(id)}
            onTemplateChange={fn => setBulkTemplateFilename(fn)}
            stratParams={bulkStratParams}
            onParamChange={(k, v) => setBulkStratParams(p => ({ ...p, [k]: v }))}
          />
          {bulkStrategyMut.isError && (
            <p className="text-xs text-red-400">{bulkStrategyMut.error?.response?.data?.detail || bulkStrategyMut.error?.message}</p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-dark-700">
          <button
            className="text-xs text-slate-400 hover:text-slate-200 border border-dark-500 rounded-lg px-4 py-2 transition-colors"
            onClick={() => setBulkStratOpen(false)}
          >
            Cancel
          </button>
          <button
            className="text-xs bg-sky-700 hover:bg-sky-600 text-white rounded-lg px-4 py-2 font-semibold transition-colors disabled:opacity-50 flex items-center gap-1.5"
            onClick={handleBulkStratApply}
            disabled={bulkStrategyMut.isPending || (bulkStratType === CUSTOM_SCRIPT_KEY && !bulkScriptId)}
          >
            <RectangleGroupIcon className="h-3.5 w-3.5" />
            {bulkStrategyMut.isPending ? 'Applying…' : `Apply to All ${positionsCount} Position${positionsCount !== 1 ? 's' : ''}`}
          </button>
        </div>
      </div>
    </div>
  )
}