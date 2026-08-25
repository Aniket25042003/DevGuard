/** Pure domain code — no downstream dependencies allowed. */
export interface Widget {
  readonly id: string;
}

export function findWidget(widgets: readonly Widget[], id: string): Widget | undefined {
  return widgets.find((widget) => widget.id === id);
}
