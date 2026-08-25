import type { Widget } from '../domain/pure.js';
import { findWidget } from '../domain/pure.js';
// Forbidden edge: application → adapter. This fixture must fail check-boundaries.
import { ThingAdapter } from '../adapter/thing.js';

export class WidgetService {
  private readonly adapter = new ThingAdapter();

  locate(widgets: readonly Widget[], id: string): Widget | undefined {
    void this.adapter.describe();
    return findWidget(widgets, id);
  }
}
