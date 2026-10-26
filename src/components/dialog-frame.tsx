"use client";
import { useEffect, useId, useRef } from "react";
import { m } from "motion/react";
import { X } from "lucide-react";
// Native dialog owns focus containment, Escape and focus restoration.
// Visual composition follows shadcn Dialog; motion follows Motion accessibility guidance.
export function DialogFrame({ title, close, children, className = "" }: {
  title: string; close: () => void; children: React.ReactNode; className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.showModal();
    dialog?.querySelector<HTMLElement>("[data-initial-focus]")?.focus({ preventScroll: true });
    return () => { dialog?.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  return <dialog ref={ref} className={`surface-dialog ${className}`} aria-labelledby={titleId}
    onCancel={close} onClick={e => {
      const rect = ref.current?.getBoundingClientRect();
      if (rect && e.target === ref.current && (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom)) close();
    }}>
    <m.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
      <div className="dialog-heading"><h2 id={titleId}>{title}</h2><button className="icon-button" aria-label={`关闭${title}`} onClick={close}><X size={17} /></button></div>
      {children}
    </m.div>
  </dialog>;
}
