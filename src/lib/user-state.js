/**
 * user-state.js: what the app keeps in memory (and in drafts) for the
 * account signed in.
 *
 * Module stores outlive a sign-out, so the next account would see, and
 * could change or save, the last one's:
 *   - the day on show (stores/diary.js), its activities (stores/activity.js)
 *     and fasts (stores/fasting.js);
 *   - every setting store (stores/settings.js): goals, meal names, keys and
 *     the rest are kept per account in storage, but each store holds the
 *     value it read last; a change still waiting to be sent is dropped;
 *   - what the Foods page hands an editor (stores/editorState.js).
 * The editors' saved drafts stay: they're kept per account
 * (lib/editor-draft.js draftScope).
 * Cleared when the account changes and on sign-out, before anything is
 * shown. Pages keep the rest in their own state, which goes with them when
 * the sign-in screen (or the account check) replaces the app. Server-wide
 * state (user management on, feature flags, update checks) stays.
 */
export async function resetUserState() {
  await Promise.allSettled([
    import('../stores/diary.js').then(m => m.resetDiaryState?.()),
    import('../stores/activity.js').then(m => m.resetActivityState?.()),
    import('../stores/fasting.js').then(m => m.resetFastingState?.()),
    import('../stores/settings.js').then(m => m.reloadSettingStores?.({ force: true })),
    import('../stores/editorState.js').then(m => { m.clearFoodEditorState?.(); m.clearMealEditorState?.(); }),
  ]);
}
