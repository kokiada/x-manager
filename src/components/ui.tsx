import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';
import type { AccountStatus } from '../db/types';
import { STATUS_LABELS } from '../db/types';

/* ------------------------------- Button ------------------------------- */

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  small?: boolean;
}

export function Button({ variant = 'default', small, className = '', ...rest }: ButtonProps) {
  const cls = ['btn', variant !== 'default' ? variant : '', small ? 'small' : '', className]
    .filter(Boolean)
    .join(' ');
  return <button className={cls} {...rest} />;
}

/* ------------------------------- Badges ------------------------------- */

export function StatusBadge({ status }: { status: AccountStatus }) {
  return <span className={`badge st-${status}`}>{STATUS_LABELS[status]}</span>;
}

export function PlainBadge({ children }: { children: ReactNode }) {
  return <span className="badge plain">{children}</span>;
}

/* ------------------------------- Modal -------------------------------- */

export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2 className="modal-title">{title}</h2>
          <Button small variant="ghost" onClick={onClose} aria-label="閉じる">
            ✕
          </Button>
        </div>
        {children}
      </div>
    </div>
  );
}

/* ------------------------------- Toasts ------------------------------- */

type ToastKind = 'info' | 'ok' | 'err';
interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

const ToastContext = createContext<{ push: (message: string, kind?: ToastKind) => void }>({
  push: () => {},
});

export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const push = useCallback((message: string, kind: ToastKind = 'info') => {
    const id = ++seq.current;
    setToasts((prev) => [...prev, { id, kind, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4200);
  }, []);

  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      <div className="toast-wrap" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind === 'info' ? '' : t.kind}`}>
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
