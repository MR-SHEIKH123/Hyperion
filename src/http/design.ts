/**
 * Design routes for brand-approved assets.
 *
 * Approval is the user promoting one asset in the gallery to "this IS the
 * brand" — the file an agent should reach for when it needs the real logo
 * rather than generating something that merely looks like it. It is a separate
 * axis from `pinned` (see migration 011): a pin says "do not auto-delete
 * this", approval says "this is canonical", and approval implies the cleanup
 * exemption without the user having to also pin.
 *
 * These live under /api/design rather than /api/storage because the decision
 * belongs to the design surface, not the disk-space panel. The read side is
 * deliberately a plain list: an agent asking "what is the brand" wants the
 * whole approved set, not a paginated gallery view of it.
 *
 * The brand decision itself is not a new table — durable notes about *why*
 * something was approved go through the existing /api/memory.
 */

import { Router } from 'express';

import { wrap } from './errors.ts';
import { asBool, body, pathParam, queryNumber } from './params.ts';
import {
  listApprovedAssets,
  setAssetBrandApproved,
  toPublic,
} from '../services/storage/gallery.ts';

export const designRouter: Router = Router();

/**
 * The approved set, newest decision first. Declared before the `:id` routes so
 * the literal segment cannot be shadowed by a future `/assets/:id` GET.
 */
designRouter.get(
  '/assets/approved',
  wrap(async (req, res) => {
    const assets = listApprovedAssets(queryNumber(req, 'limit') ?? 100);
    res.json({ assets, total: assets.length });
  }),
);

/**
 * Approve an asset. `approved` in the body is optional: omitted, this toggles,
 * which is what a single button in the gallery wants.
 */
designRouter.post(
  '/assets/:id/approve',
  wrap(async (req, res) => {
    const id = pathParam(req, 'id');
    const approved = asBool(body(req).approved, 'approved');
    const asset =
      approved === undefined ? setAssetBrandApproved(id) : setAssetBrandApproved(id, approved);
    res.json({ asset: toPublic(asset) });
  }),
);

/**
 * Revoke approval. A separate route rather than only the toggle above so the
 * frontend can revoke idempotently — clicking "remove from brand" twice must
 * not re-approve the asset.
 */
designRouter.post(
  '/assets/:id/unapprove',
  wrap(async (req, res) => {
    const asset = setAssetBrandApproved(pathParam(req, 'id'), false);
    res.json({ asset: toPublic(asset) });
  }),
);
