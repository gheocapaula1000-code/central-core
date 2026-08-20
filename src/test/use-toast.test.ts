import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { reducer, toast, useToast } from "@/hooks/use-toast";

describe("use-toast reducer", () => {
  it("adds, updates, dismisses and removes toasts", () => {
    const added = reducer(
      { toasts: [] },
      { type: "ADD_TOAST", toast: { id: "1", open: true, title: "ciao" } },
    );
    expect(added.toasts).toHaveLength(1);
    expect(added.toasts[0].title).toBe("ciao");

    const updated = reducer(added, {
      type: "UPDATE_TOAST",
      toast: { id: "1", title: "dopo" },
    });
    expect(updated.toasts[0].title).toBe("dopo");

    const dismissed = reducer(updated, { type: "DISMISS_TOAST", toastId: "1" });
    expect(dismissed.toasts[0].open).toBe(false);

    const dismissedAll = reducer(updated, { type: "DISMISS_TOAST" });
    expect(dismissedAll.toasts.every((t) => t.open === false)).toBe(true);

    const removed = reducer(dismissed, { type: "REMOVE_TOAST", toastId: "1" });
    expect(removed.toasts).toHaveLength(0);

    const cleared = reducer(updated, { type: "REMOVE_TOAST" });
    expect(cleared.toasts).toHaveLength(0);
  });

  it("keeps only the latest toast", () => {
    const first = reducer(
      { toasts: [] },
      { type: "ADD_TOAST", toast: { id: "1", open: true, title: "a" } },
    );
    const second = reducer(first, {
      type: "ADD_TOAST",
      toast: { id: "2", open: true, title: "b" },
    });
    expect(second.toasts.map((t) => t.id)).toEqual(["2"]);
  });
});

describe("toast() and useToast", () => {
  it("creates, updates and dismisses a live toast", () => {
    const { result } = renderHook(() => useToast());
    let created: { id: string; dismiss: () => void; update: (p: { title?: string }) => void };

    act(() => {
      created = toast({ title: "primo" });
    });
    expect(result.current.toasts[0]?.title).toBe("primo");

    act(() => {
      created.update({ title: "secondo" });
    });
    expect(result.current.toasts[0]?.title).toBe("secondo");

    act(() => {
      created.dismiss();
    });
    expect(result.current.toasts[0]?.open).toBe(false);

    act(() => {
      result.current.dismiss();
    });
    expect(result.current.toasts.every((t) => t.open === false)).toBe(true);

    const openChange = result.current.toasts[0]?.onOpenChange;
    act(() => {
      openChange?.(false);
    });
  });
});
