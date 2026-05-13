import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CheckIcon, PencilSquareIcon, PlusIcon, XMarkIcon, Bars3Icon, ChevronDownIcon } from '@heroicons/react/24/solid'
import QuoteCard from './QuoteCard'
import { getBulkQuotes } from '../../api/client'
import { useMarketOpen } from '../../hooks/useMarketOpen'
import { useAppSettings } from '../../hooks/useAppSettings'
import { WATCHLIST_SYMBOL_LIMIT } from '../../hooks/useWatchlist'

const PRESET_LISTS = {
  watchlist: { label: 'My Watchlist', symbols: null /* dynamic */ },
  major_markets: {
    label: 'Major Markets',
    symbols: ['SPY', 'QQQ', 'DIA', 'IWM', 'VTI', 'EFA', 'EEM', 'GLD', 'TLT', 'VIXY'],
  },
  notable_sectors: {
    label: 'Notable Sectors',
    symbols: ['XLK', 'XLF', 'XLE', 'XLV', 'XLI', 'XLC', 'XLY', 'XLRE', 'XLB', 'XLU'],
  },
  gainers: {
    label: 'Top Gainers',
    symbols: ['NVDA', 'META', 'AVGO', 'SMCI', 'ARM', 'PLTR', 'MSTR', 'CRWD', 'PANW', 'SNOW'],
  },
  losers: {
    label: 'Recent Losers',
    symbols: ['INTC', 'PFE', 'WBA', 'MPW', 'PARA', 'DISH', 'BBBY', 'NCLH', 'AAL', 'UAL'],
  },
  big_tech: {
    label: 'Big Tech',
    symbols: ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'TSLA', 'NFLX', 'ADBE', 'CRM'],
  },
  crypto_etfs: {
    label: 'Crypto & Alt',
    symbols: ['IBIT', 'FBTC', 'BITO', 'GBTC', 'ARKW', 'ARKK', 'BLOK', 'BITB', 'HODL', 'BTCO'],
  },
}

export default function WatchlistPanel({
  watchlist, quotesMap, quotesLoading, chartSymbol, setChartSymbol,
  addNotice, setAddNotice,
  editing, toggleEditing,
  addInput, addError, addLoading, addSuggestions, showSuggestions,
  handleAdd, handleAddInputChange, handleAddKey, setShowSuggestions,
  removeSymbol, onDragStart, onDragEnter, onDragEnd,
}) {
  const appSettings = useAppSettings()
  const marketOpen = useMarketOpen(null)
  const [selectedList, setSelectedList] = useState('watchlist')
  const [dropdownOpen, setDropdownOpen] = useState(false)

  const isWatchlist = selectedList === 'watchlist'
  const presetSymbols = isWatchlist ? watchlist : (PRESET_LISTS[selectedList]?.symbols ?? [])

  const { data: presetQuotesMap, isLoading: presetLoading } = useQuery({
    queryKey: ['bulk-quotes', presetSymbols],
    queryFn: () => getBulkQuotes(presetSymbols),
    staleTime: 30_000,
    refetchInterval: marketOpen ? appSettings.quotes_refresh_ms : 5 * 60_000,
    refetchIntervalInBackground: true,
    enabled: !isWatchlist && presetSymbols.length > 0,
  })

  const activeQuotesMap = isWatchlist ? quotesMap : presetQuotesMap
  const activeLoading = isWatchlist ? quotesLoading : presetLoading
  const activeSymbols = presetSymbols

  return (
    <div className="flex flex-col h-full">
      {/* Dropdown selector */}
      <div className="relative mb-2">
        <button
          onClick={() => setDropdownOpen(o => !o)}
          className="w-full flex items-center justify-between px-3 py-2 rounded-lg bg-dark-700 border border-dark-500 hover:border-dark-400 transition-colors text-sm font-medium text-slate-200"
        >
          <span>{PRESET_LISTS[selectedList]?.label ?? 'Watchlist'}</span>
          <ChevronDownIcon className={`h-4 w-4 text-slate-400 transition-transform ${dropdownOpen ? 'rotate-180' : ''}`} />
        </button>
        {dropdownOpen && (
          <div className="absolute top-full left-0 right-0 mt-1 z-50 bg-dark-700 border border-dark-500 rounded-lg shadow-2xl overflow-hidden">
            {Object.entries(PRESET_LISTS).map(([key, { label }]) => (
              <button
                key={key}
                onClick={() => { setSelectedList(key); setDropdownOpen(false) }}
                className={`w-full text-left px-3 py-2 text-sm transition-colors ${
                  selectedList === key
                    ? 'bg-emerald-600/20 text-emerald-400'
                    : 'text-slate-300 hover:bg-dark-600 hover:text-slate-100'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Edit controls — only for watchlist */}
      {isWatchlist && (
        <div className="flex items-center justify-end mb-2">
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
      )}

      {/* Add input — only when editing watchlist */}
      {isWatchlist && editing && (
        <div className="flex items-start gap-2 mb-3">
          <div className="relative flex-1">
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

      {isWatchlist && (
        <div className="mb-2 text-[11px] text-slate-500">
          {watchlist.length}/{WATCHLIST_SYMBOL_LIMIT} symbols
        </div>
      )}

      {isWatchlist && addNotice && (
        <div className="mb-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-300 flex items-start gap-2">
          <span className="flex-1">{addNotice}</span>
          <button
            onClick={() => setAddNotice('')}
            className="text-amber-300/80 hover:text-amber-200"
            aria-label="Dismiss notice"
          >
            <XMarkIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Scrollable symbol list */}
      <div
        className="flex-1 overflow-y-auto overflow-x-visible space-y-0.5 pr-0.5"
        style={{ scrollbarWidth: 'thin', scrollbarColor: '#334155 transparent' }}
      >
        {activeSymbols.map((sym, idx) => (
          <div
            key={sym}
            draggable={isWatchlist && editing}
            onDragStart={() => isWatchlist && onDragStart(idx)}
            onDragEnter={() => isWatchlist && onDragEnter(idx)}
            onDragEnd={() => isWatchlist && onDragEnd()}
            onDragOver={e => e.preventDefault()}
            onClick={() => { if (!editing) setChartSymbol(sym) }}
            className={`relative ${isWatchlist && editing ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'}`}
          >
            <QuoteCard
              data={activeQuotesMap?.[sym]}
              isLoading={activeLoading}
              symbol={sym}
              isActive={sym === chartSymbol}
            />
            {isWatchlist && editing && (
              <>
                <button
                  onClick={e => { e.stopPropagation(); removeSymbol(sym) }}
                  className="absolute top-1/2 -translate-y-1/2 -right-1 h-5 w-5 rounded-full bg-red-500 hover:bg-red-400 flex items-center justify-center shadow-lg transition-colors z-10"
                >
                  <XMarkIcon className="h-3 w-3 text-white" />
                </button>
                <div className="absolute top-1/2 -translate-y-1/2 left-0 text-slate-600 pointer-events-none">
                  <Bars3Icon className="h-3.5 w-3.5" />
                </div>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
