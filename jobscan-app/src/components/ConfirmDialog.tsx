import { AlertTriangle } from 'lucide-react'

interface Props {
  message: string
  confirmLabel?: string
  cancelLabel?: string
  onConfirm: () => void
  onCancel: () => void
}

export default function ConfirmDialog({
  message, confirmLabel = 'Continue', cancelLabel = 'Cancel', onConfirm, onCancel,
}: Props) {
  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={onCancel}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="modal-in bg-gray-900 border border-white/[0.08] rounded-2xl max-w-md w-full p-6 flex flex-col gap-4 shadow-2xl"
      >
        <div className="flex items-start gap-3">
          <AlertTriangle size={22} className="text-amber-400 shrink-0 mt-0.5" />
          <p className="text-sm text-gray-200 leading-relaxed">{message}</p>
        </div>
        <div className="flex justify-end gap-2 mt-2">
          <button
            onClick={onCancel}
            className="text-gray-400 hover:text-white px-4 py-2 rounded-full text-sm bg-white/[0.06] hover:bg-white/[0.1] border border-white/[0.08] transition-colors"
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            className="bg-red-700 hover:bg-red-600 text-white px-4 py-2 rounded-full text-sm font-medium transition-colors"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
