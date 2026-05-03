import { CheckIcon, PencilSquareIcon, PlusIcon, XMarkIcon, Bars3Icon } from '@heroicons/react/24/solid'
import QuoteCard from './QuoteCard'

export default function WatchlistPanel({
  watchlist, quotesMap, quotesLoading, chartSymbol, setChartSymbol,
  editing, toggleEditing,
  addInput, addError, addLoading, addSuggestions, showSuggestions,
  handleAdd, handleAddInputChange, handleAddKey, setShowSuggestions,
  removeSymbol, onDragStart, onDragEnter, onDragEnd,
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider">Watchlist</h2>
        <button
          onClick={toggleEditing}
          className={`flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md border transition-colors ${
            editing
              ? 'bg-emerald-600/20 border-emerald-600 text-emerald-400'
              : 'border-dark-500 text-slate-400 hover:text-slate-200 hover:border-dark-400'
          }`}
        >
          {editing ? <CheckIcon className="h-3.5 w-3.5" /> : <PencilSquareIcon className="h-3.5 w-3.5" />}
          {editing ? 'Done' : 'Edit'}
        </button>
      </div>

      {editing && (
        <div className="flex items-start gap-2 mb-5">
          <div className="relative flex-1 max-w-xs">
            <input
              value={addInput}
              onChange={handleAddInputChange}
              onKeyDown={handleAddKey}
              onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
              onFocus={() => addSuggestions.length > 0 && setShowSuggestions(true)}
              placeholder="Add symbol or company name…"
              maxLength={10}
              className="w-full bg-dark-700 border border-dark-500 rounded-md px-3 py-1.5 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-emerald-600 font-mono uppercase"
            />
            {addError && (
              <p className="absolute -bottom-5 left-0 text-xs text-red-400">{addError}</p>
            )}
            {showSuggestions && (
              <ul className="absolute top-full left-0 right-0 mt-1 z-50 bg-dark-700 border border-dark-500 rounded-md shadow-xl overflow-hidden max-h-56 overflow-y-auto">
                {addSuggestions.map(s => (
                  <li
                    key={s.symbol}
                    onMouseDown={() => handleAdd(s.symbol)}
                    className="flex items-center justify-between px-3 py-2 hover:bg-dark-600 cursor-pointer"
                  >
                    <span className="font-mono font-semibold text-sm text-slate-200">{s.symbol}</span>
                    <span className="text-xs text-slate-400 truncate ml-3 text-right">{s.name}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <button
            onClick={() => handleAdd()}
            disabled={addLoading || !addInput.trim()}
            className="flex items-center gap-1 px-3 py-1.5 text-xs rounded-md bg-emerald-600 hover:bg-emerald-500 text-white font-semibold disabled:opacity-40 transition-colors"
          >
            {addLoading ? (
              <span className="h-3.5 w-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin inline-block" />
            ) : (
              <PlusIcon className="h-3.5 w-3.5" />
            )}
            Add
          </button>
        </div>
      )}

      <div
        className="overflow-y-auto mt-1 px-1 pt-1 pb-2"
        style={{ maxHeight: '132px', scrollbarWidth: 'thin', scrollbarColor: '#334155 transparent' }}
      >
        <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3">
          {watchlist.map((sym, idx) => (
          <div
            key={sym}
            draggable={editing}
            onDragStart={() => onDragStart(idx)}
            onDragEnter={() => onDragEnter(idx)}
            onDragEnd={onDragEnd}
            onDragOver={e => e.preventDefault()}
            onClick={() => { if (!editing) setChartSymbol(sym) }}
            className={`relative rounded-xl transition-all ${
              sym === chartSymbol && !editing
                ? 'ring-2 ring-emerald-400'
                : ''
            } ${editing ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'}`}
          >
            <QuoteCard data={quotesMap?.[sym]} isLoading={quotesLoading} symbol={sym} />
            {editing && (
              <>
                <button
                  onClick={e => { e.stopPropagation(); removeSymbol(sym) }}
                  className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-red-500 hover:bg-red-400 flex items-center justify-center shadow-lg transition-colors z-10"
                >
                  <XMarkIcon className="h-3 w-3 text-white" />
                </button>
                <div className="absolute top-1.5 left-1.5 text-slate-500 pointer-events-none">
                  <Bars3Icon className="h-3.5 w-3.5" />
                </div>
              </>
            )}
          </div>
          ))}
        </div>
      </div>
    </div>
  )
}
