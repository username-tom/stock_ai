/**
 * Reusable symbol search input with debounced autocomplete dropdown.
 *
 * Props:
 *  value          – controlled string value (the current symbol)
 *  onChange       – called with the new symbol string whenever it changes
 *  onSelect       – (optional) called with { symbol, name, exchange } when a suggestion is clicked
 *  placeholder    – input placeholder text
 *  className      – extra classes for the wrapper div
 *  inputClassName – extra classes for the <input>
 *  disabled       – disables the input
 *  autoFocus      – focuses on mount
 *  extraSuggestions – array of { symbol, name? } to show before API results (e.g. watchlist)
 */
import { useState, useRef, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { searchSymbols } from '../../api/client'

export default function SymbolAutocomplete({
  value = '',
  onChange,
  onSelect,
  placeholder = 'Search symbol or name…',
  className = '',
  inputClassName = '',
  disabled = false,
  autoFocus = false,
  extraSuggestions = [],
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState(value)
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const debounceRef = useRef(null)
  const wrapperRef = useRef(null)

  // Keep internal query in sync when parent changes value externally
  useEffect(() => { setQuery(value) }, [value])

  // Debounce the API search
  useEffect(() => {
    clearTimeout(debounceRef.current)
    if (query.length < 1) { setDebouncedQuery(''); return }
    debounceRef.current = setTimeout(() => setDebouncedQuery(query), 200)
    return () => clearTimeout(debounceRef.current)
  }, [query])

  const { data: apiResults = [] } = useQuery({
    queryKey: ['symbol-search', debouncedQuery],
    queryFn: () => searchSymbols(debouncedQuery, 8),
    enabled: debouncedQuery.length >= 1,
    staleTime: 10_000,
  })

  const apiHits = Array.isArray(apiResults) ? apiResults : (apiResults?.results ?? [])

  // Merge extraSuggestions (e.g. watchlist) that match the query, deduplicate with API results
  const apiSymbols = new Set(apiHits.map(h => h.symbol))
  const q = query.trim().toUpperCase()
  const filteredExtras = extraSuggestions.filter(
    e => !apiSymbols.has(e.symbol) && (!q || e.symbol.includes(q) || e.name?.toUpperCase().includes(q))
  )
  const suggestions = [...filteredExtras, ...apiHits]

  // Show a "use typed value" option if the typed text isn't in the list
  const showTyped = q && !suggestions.some(s => s.symbol === q)

  function handleInputChange(e) {
    const v = e.target.value.toUpperCase()
    setQuery(v)
    setOpen(true)
    onChange?.(v)
  }

  function handleSelect(hit) {
    setQuery(hit.symbol)
    setOpen(false)
    onChange?.(hit.symbol)
    onSelect?.(hit)
  }

  function handleKeyDown(e) {
    if (e.key === 'Escape') setOpen(false)
    if (e.key === 'Enter') setOpen(false)
  }

  // Close on outside click
  useEffect(() => {
    function handleClick(e) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const showDropdown = open && (suggestions.length > 0 || showTyped)

  return (
    <div ref={wrapperRef} className={`relative ${className}`}>
      <input
        className={`input w-full font-mono uppercase ${inputClassName}`}
        value={query}
        onChange={handleInputChange}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        autoComplete="off"
        spellCheck={false}
      />

      {showDropdown && (
        <ul className="absolute top-full left-0 right-0 z-50 mt-1 bg-dark-700 border border-dark-400 rounded-lg shadow-xl max-h-60 overflow-y-auto">
          {suggestions.map(hit => (
            <li key={hit.symbol}>
              <button
                type="button"
                onMouseDown={() => handleSelect(hit)}
                className="w-full text-left px-3 py-2 hover:bg-dark-600 transition-colors flex items-center justify-between gap-2"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-bold text-slate-100 text-sm shrink-0">{hit.symbol}</span>
                  {hit.name && (
                    <span className="text-xs text-slate-400 truncate">{hit.name}</span>
                  )}
                </div>
                {hit.exchange && (
                  <span className="text-xs text-slate-600 shrink-0">{hit.exchange}</span>
                )}
              </button>
            </li>
          ))}
          {showTyped && (
            <li>
              <button
                type="button"
                onMouseDown={() => handleSelect({ symbol: q, name: '' })}
                className="w-full text-left px-3 py-2 hover:bg-dark-600 transition-colors text-sm text-slate-400 italic"
              >
                Use &ldquo;{q}&rdquo;
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  )
}
