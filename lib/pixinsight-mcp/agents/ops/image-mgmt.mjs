// ============================================================================
// Image management: clone, restore, close, purge
// ============================================================================

/**
 * Clone an open image to a new hidden window (in-memory, no disk I/O).
 * One round trip: PJSR reads the source geometry and builds the copy itself,
 * so the source dimensions never have to travel to Node and back.
 */
export async function cloneImage(ctx, sourceId, cloneId) {
  const r = await ctx.pjsr(`
    var old = ImageWindow.windowById('${cloneId}');
    if (!old.isNull) old.forceClose();
    var srcW = ImageWindow.windowById('${sourceId}');
    if (srcW.isNull) throw new Error('cloneImage: source not found: ${sourceId}');
    var src = srcW.mainView.image;
    var clone = new ImageWindow(src.width, src.height, src.numberOfChannels, 32, true, src.isColor, '${cloneId}');
    clone.mainView.beginProcess();
    clone.mainView.image.assign(src);
    clone.mainView.endProcess();
    clone.hide();
    'OK';
  `);
  if (r.status === 'error') throw new Error('cloneImage: ' + r.error.message);
  return { source_id: sourceId, clone_id: cloneId };
}

/**
 * Restore target image from a clone (in-memory copy).
 */
export async function restoreFromClone(ctx, targetId, cloneId) {
  const r = await ctx.pjsr(`
    var srcW = ImageWindow.windowById('${targetId}');
    var clone = ImageWindow.windowById('${cloneId}');
    if (srcW.isNull) throw new Error('restoreFromClone: target not found: ${targetId}');
    if (clone.isNull) throw new Error('restoreFromClone: clone not found: ${cloneId}');
    // Image.assign() silently collapses a colour target to mono when the source
    // is mono (and the reverse leaves dead channels): refuse instead of
    // corrupting the image. Rebuild the target with cloneImage() instead.
    var tCh = srcW.mainView.image.numberOfChannels;
    var sCh = clone.mainView.image.numberOfChannels;
    if (tCh !== sCh) {
      throw new Error('restoreFromClone: channel count mismatch — target ${targetId} has '
        + tCh + ', clone ${cloneId} has ' + sCh
        + '. assign() would collapse the image; recreate the target with the right channel count.');
    }
    srcW.mainView.beginProcess();
    srcW.mainView.image.assign(clone.mainView.image);
    srcW.mainView.endProcess();
    'OK';
  `);
  if (r.status === 'error') throw new Error('restoreFromClone: ' + r.error.message);
  return { target_id: targetId, clone_id: cloneId, restored: true };
}

/**
 * Close an image window.
 */
export async function closeImage(ctx, viewId) {
  const r = await ctx.pjsr(`var w = ImageWindow.windowById('${viewId}'); var had = !w.isNull; if (had) w.forceClose(); JSON.stringify({ closed: had });`);
  return { view_id: viewId, closed: r.status !== 'error' };
}

/**
 * Purge undo history for a view to free memory.
 */
export async function purgeUndoHistory(ctx, viewId) {
  const r = await ctx.pjsr(`var w = ImageWindow.windowById('${viewId}'); if (!w.isNull) w.purge(); 'OK';`);
  return { view_id: viewId, purged: r.status !== 'error' };
}
