import { useCallback, useEffect, useRef, useState } from "react";

export type Toast = {
  id: number;
  type: "info" | "success" | "warn" | "error";
  title: string;
  message: string;
};

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastIdRef = useRef(0);
  const timeoutIdsRef = useRef<number[]>([]);

  useEffect(() => {
    return () => {
      timeoutIdsRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId));
      timeoutIdsRef.current = [];
    };
  }, []);

  const removeToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  const addToast = useCallback(
    (type: Toast["type"], title: string, message: string) => {
      const id = ++toastIdRef.current;
      setToasts((prev) => [...prev, { id, type, title, message }]);

      const ttl = type === "error" ? 10_000 : 6_000;
      const timeoutId = window.setTimeout(() => {
        removeToast(id);
        timeoutIdsRef.current = timeoutIdsRef.current.filter((currentId) => currentId !== timeoutId);
      }, ttl);
      timeoutIdsRef.current.push(timeoutId);
    },
    [removeToast],
  );

  return {
    toasts,
    addToast,
    removeToast,
  };
}
