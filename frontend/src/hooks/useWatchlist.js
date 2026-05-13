import { useState, useRef } from 'react'
import { getQuote, searchSymbols } from '../api/client'
import { setSetting } from './useAppSettings'

const DEFAULT_WATCHLIST = ['AAPL', 'MSFT', 'GOOGL', 'TSLA', 'NVDA', 'SPY']
const STORAGE_KEY = 'dashboard_watchlist'
export const WATCHLIST_SYMBOL_LIMIT = 20
const OVER_LIMIT_QUOTES_REFRESH_MS = 15_000

function loadWatchlist() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) {
      const parsed = JSON.parse(saved)
      if (Array.isArray(parsed)) {
        return parsed.slice(0, WATCHLIST_SYMBOL_LIMIT)
      }
    }
  } catch {}
  return DEFAULT_WATCHLIST
}

function saveWatchlist(list) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)) } catch {}
}

export function useWatchlist() {
  const [watchlist, setWatchlist] = useState(loadWatchlist)
  const [addNotice, setAddNotice] = useState('')
  const [editing, setEditing] = useState(false)
  const [addInput, setAddInput] = useState('')
  const [addError, setAddError] = useState('')
  const [addLoading, setAddLoading] = useState(false)
  const [addSuggestions, setAddSuggestions] = useState([])
  const [showSuggestions, setShowSuggestions] = useState(false)
  const addDebounce = useRef(null)
  const dragItem = useRef(null)
  const dragOver = useRef(null)

  const updateWatchlist = (next) => {
    const trimmed = next.slice(0, WATCHLIST_SYMBOL_LIMIT)
    setWatchlist(trimmed)
    saveWatchlist(trimmed)
    window.dispatchEvent(new Event('watchlist-updated'))
  }

  const addWithLimitPolicy = (sym) => {
    if (watchlist.includes(sym)) return { added: false, reason: 'duplicate' }

    if (watchlist.length < WATCHLIST_SYMBOL_LIMIT) {
      updateWatchlist([...watchlist, sym])
      return { added: true, downgraded: false }
    }

    const oldest = watchlist[0]
    const confirmed = window.confirm(
      `Watchlist limit is ${WATCHLIST_SYMBOL_LIMIT} symbols. Add ${sym} by replacing ${oldest} and reduce quotes refresh to 15s?`
    )
    if (!confirmed) {
      return { added: false, reason: 'cancelled' }
    }

    setSetting('quotes_refresh_ms', OVER_LIMIT_QUOTES_REFRESH_MS)
    setAddNotice(
      `Watchlist limit reached: replaced ${oldest} with ${sym}. Quotes refresh set to 15s.`
    )
    updateWatchlist([...watchlist.slice(1), sym])
    return { added: true, downgraded: true }
  }

  const removeSymbol = (sym) => updateWatchlist(watchlist.filter(s => s !== sym))

  // Direct add without async validation — for known-valid symbols (e.g. from movers list)
  const addSymbol = (sym) => {
    addWithLimitPolicy(sym)
  }

  const toggleSymbol = (sym) => {
    watchlist.includes(sym) ? removeSymbol(sym) : addSymbol(sym)
  }

  const handleAdd = async (sym = addInput.trim().toUpperCase()) => {
    if (!sym) return
    setShowSuggestions(false)
    if (watchlist.includes(sym)) { setAddError('Already in watchlist'); return }
    setAddLoading(true)
    setAddError('')
    try {
      await getQuote(sym)
      const result = addWithLimitPolicy(sym)
      if (result.added) {
        setAddInput('')
        setAddSuggestions([])
      } else if (result.reason === 'cancelled') {
        setAddError(`Limit is ${WATCHLIST_SYMBOL_LIMIT}. Add cancelled.`)
      }
    } catch {
      setAddError('Symbol not found')
    } finally {
      setAddLoading(false)
    }
  }

  const handleAddInputChange = (e) => {
    const val = e.target.value.toUpperCase()
    setAddInput(val)
    setAddError('')
    clearTimeout(addDebounce.current)
    if (val.length < 1) { setAddSuggestions([]); setShowSuggestions(false); return }
    addDebounce.current = setTimeout(() => {
      searchSymbols(val, 8).then(results => {
        setAddSuggestions(results)
        setShowSuggestions(results.length > 0)
      }).catch(() => {})
    }, 200)
  }

  const handleAddKey = (e) => {
    if (e.key === 'Enter') handleAdd()
    else if (e.key === 'Escape') setShowSuggestions(false)
  }

  const onDragStart = (index) => { dragItem.current = index }
  const onDragEnter = (index) => { dragOver.current = index }
  const onDragEnd = () => {
    if (dragItem.current === null || dragOver.current === null || dragItem.current === dragOver.current) {
      dragItem.current = null; dragOver.current = null; return
    }
    const next = [...watchlist]
    const [moved] = next.splice(dragItem.current, 1)
    next.splice(dragOver.current, 0, moved)
    dragItem.current = null; dragOver.current = null
    updateWatchlist(next)
  }

  const toggleEditing = () => { setEditing(e => !e); setAddInput(''); setAddError('') }

  return {
    watchlist, updateWatchlist,
    addNotice, setAddNotice,
    editing, toggleEditing,
    addInput, addError, addLoading, addSuggestions, showSuggestions,
    handleAdd, handleAddInputChange, handleAddKey,
    setShowSuggestions,
    removeSymbol, addSymbol, toggleSymbol,
    onDragStart, onDragEnter, onDragEnd,
  }
}
