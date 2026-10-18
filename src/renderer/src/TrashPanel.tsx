import { useEffect, useRef, useState } from 'react'
import type { ConversationSummary, TrashedConversation } from '../../shared/types'
import { Icon } from './Visuals'

interface Props {
  onClose(): void
  onRestored(conversation: ConversationSummary): void
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : '操作未完成，请重试。'
}

export default function TrashPanel({ onClose, onRestored }: Props) {
  const [items, setItems] = useState<TrashedConversation[] | null>(null)
  const [error, setError] = useState('')
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [confirmBatchDelete, setConfirmBatchDelete] = useState(false)
  const [confirmClearAll, setConfirmClearAll] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  const mounted = useRef(true)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const clearSelection = () => {
    setSelectedIds(new Set())
  }

  useEffect(() => {
    mounted.current = true
    window.her.listTrashedConversations()
      .then((list) => { if (mounted.current) setItems(list) })
      .catch((cause) => { if (mounted.current) { setItems([]); setError(`无法读取回收站：${messageOf(cause)}`) } })
    const dialog = dialogRef.current
    dialog?.focus()
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') closeRef.current()
      if (event.key !== 'Tab' || !dialog) return
      const elements = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]')]
      const first = elements[0]
      const last = elements.at(-1)
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    dialog?.addEventListener('keydown', onKeyDown)
    return () => { mounted.current = false; dialog?.removeEventListener('keydown', onKeyDown) }
  }, [])

  async function restore(id: string) {
    setBusy(true)
    setError('')
    try {
      const restored = await window.her.restoreConversation(id)
      onRestored(restored)
      if (mounted.current) {
        setItems((list) => list && list.filter((item) => item.id !== id))
        setSelectedIds((ids) => { const next = new Set(ids); next.delete(id); return next })
      }
    } catch (cause) { if (mounted.current) setError(`无法恢复：${messageOf(cause)}`) }
    finally { if (mounted.current) setBusy(false) }
  }

  async function purge(id: string) {
    setBusy(true)
    setError('')
    try {
      await window.her.purgeConversation(id)
      if (mounted.current) {
        setItems((list) => list && list.filter((item) => item.id !== id))
        setSelectedIds((ids) => { const next = new Set(ids); next.delete(id); return next })
        setConfirmId(null)
      }
    } catch (cause) { if (mounted.current) setError(`无法永久删除：${messageOf(cause)}`) }
    finally { if (mounted.current) setBusy(false) }
  }

  async function purgeBatch() {
    if (selectedIds.size === 0) return
    setBusy(true)
    setError('')
    try {
      await window.her.purgeConversations(Array.from(selectedIds))
      if (mounted.current) {
        setItems((list) => list && list.filter((item) => !selectedIds.has(item.id)))
        setSelectedIds(new Set())
        setConfirmBatchDelete(false)
      }
    } catch (cause) {
      if (mounted.current) {
        setError(`无法批量删除：${messageOf(cause)}`)
        // Refresh list to sync with actual state
        try {
          const list = await window.her.listTrashedConversations()
          if (mounted.current) setItems(list)
        } catch {}
      }
    }
    finally { if (mounted.current) setBusy(false) }
  }

  async function clearAll() {
    if (!items || items.length === 0) return
    setBusy(true)
    setError('')
    try {
      const allIds = items.map(item => item.id)
      await window.her.purgeConversations(allIds)
      if (mounted.current) {
        setItems([])
        setSelectedIds(new Set())
        setConfirmClearAll(false)
      }
    } catch (cause) {
      if (mounted.current) {
        setError(`无法清空回收站：${messageOf(cause)}`)
        // Refresh list to sync with actual state
        try {
          const list = await window.her.listTrashedConversations()
          if (mounted.current) setItems(list)
        } catch {}
      }
    }
    finally { if (mounted.current) setBusy(false) }
  }

  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}>
    <div className="settings-dialog trash-dialog" role="dialog" aria-modal="true" aria-labelledby="trash-title" tabIndex={-1} ref={dialogRef}>
      <header className="settings-header">
        <div>
          <p className="eyebrow">删除的对话会留在这里</p>
          <h2 id="trash-title">回收站</h2>
        </div>
        {items && items.length > 0 && (
          <div className="trash-header-actions">
            {selectedIds.size > 0 ? (
              <>
                <span className="selected-count">{selectedIds.size} 项已选</span>
                <button
                  className="secondary-button"
                  disabled={busy}
                  onClick={clearSelection}
                >
                  取消选择
                </button>
                <button
                  className="danger-button"
                  disabled={busy}
                  onClick={() => setConfirmBatchDelete(true)}
                >
                  <Icon name="trash" />
                  删除选中项
                </button>
              </>
            ) : (
              <button
                className="danger-button-outline"
                disabled={busy}
                onClick={() => setConfirmClearAll(true)}
              >
                <Icon name="trash" />
                清空回收站
              </button>
            )}
          </div>
        )}
        <button className="icon-button" aria-label="关闭回收站" onClick={onClose}><Icon name="close" /></button>
      </header>
      <div className="settings-content">
        {error && <div className="error-banner" role="alert">{error}</div>}
        {items === null ? <p className="trash-empty" role="status">正在读取…</p> : items.length === 0 ? <p className="trash-empty">回收站是空的。</p> : <ul className="trash-list" aria-label="已删除的对话">{items.map((item) => <li key={item.id} className={`trash-row${selectedIds.has(item.id) ? ' selected' : ''}`}>
          <div className="trash-checkbox">
            <input
              type="checkbox"
              checked={selectedIds.has(item.id)}
              onChange={() => toggleSelect(item.id)}
              disabled={busy || confirmId === item.id}
              aria-label={`选择 ${item.title}`}
            />
          </div>
          <div className="trash-info"><strong>{item.title}</strong><small>删除于 {new Date(item.deletedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</small></div>
          {confirmId === item.id ? <div className="delete-confirm"><span>永久删除后无法恢复。</span><button className="danger-button" disabled={busy} onClick={() => void purge(item.id)}>确认永久删除</button><button className="text-button" disabled={busy} onClick={() => setConfirmId(null)}>取消</button></div>
            : <div className="trash-actions"><button className="text-button" aria-label={`恢复 ${item.title}`} disabled={busy || selectedIds.size > 0} onClick={() => void restore(item.id)}><Icon name="retry" />恢复</button><button className="text-button danger" aria-label={`永久删除 ${item.title}`} disabled={busy || selectedIds.size > 0} onClick={() => setConfirmId(item.id)}><Icon name="trash" />永久删除</button></div>}
        </li>)}</ul>}
      </div>
      {confirmBatchDelete && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setConfirmBatchDelete(false) }}>
          <div className="settings-dialog" role="alertdialog" aria-modal="true" aria-labelledby="batch-delete-title" aria-describedby="batch-delete-desc">
            <header className="settings-header">
              <h2 id="batch-delete-title">确认批量删除</h2>
            </header>
            <div className="settings-content">
              <p id="batch-delete-desc">将永久删除 {selectedIds.size} 个对话，删除后无法恢复。</p>
              <div className="dialog-actions">
                <button className="danger-button" disabled={busy} onClick={() => void purgeBatch()}>确认删除</button>
                <button className="text-button" disabled={busy} onClick={() => setConfirmBatchDelete(false)}>取消</button>
              </div>
            </div>
          </div>
        </div>
      )}
      {confirmClearAll && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setConfirmClearAll(false) }}>
          <div className="settings-dialog" role="alertdialog" aria-modal="true" aria-labelledby="clear-all-title" aria-describedby="clear-all-desc">
            <header className="settings-header">
              <h2 id="clear-all-title">确认清空回收站</h2>
            </header>
            <div className="settings-content">
              <p id="clear-all-desc">将永久删除回收站中的所有 {items?.length || 0} 个对话，删除后无法恢复。</p>
              <div className="dialog-actions">
                <button className="danger-button" disabled={busy} onClick={() => void clearAll()}>确认清空</button>
                <button className="text-button" disabled={busy} onClick={() => setConfirmClearAll(false)}>取消</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  </div>
}
