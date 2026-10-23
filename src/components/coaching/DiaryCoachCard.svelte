<script>
  // A coach's new targets, shown once on the Diary: the first time the Diary
  // opens after they arrive. They stay on Goals until answered. Nothing for
  // anyone without a coach (no request, nothing on screen).
  import { onMount } from 'svelte';
  import { coachTab, coachingState, coachRecommendations, loadCoachRecommendations } from '../../stores/coaching.js';
  import { coachNameFor } from '../../lib/coaching-view.js';
  import TargetsCard from './TargetsCard.svelte';

  const KEY = () => `nt:coach-rec-seen:${localStorage.getItem('wl:userId') || ''}`;
  let shown = null;

  function seen() { try { return new Set(JSON.parse(localStorage.getItem(KEY()) || '[]')); } catch { return new Set(); } }
  function markSeen(id) {
    try { const s = seen(); s.add(id); localStorage.setItem(KEY(), JSON.stringify([...s].slice(-200))); } catch { /* private mode */ }
  }

  onMount(async () => {
    if (!$coachTab) return;
    const recs = await loadCoachRecommendations({ refresh: true }).catch(() => []);
    const s = seen();
    const next = (recs || []).find(r => r.kind === 'targets' && r.status === 'pending' && !s.has(r.id));
    if (next) { shown = next.id; markSeen(next.id); }
  });

  // Kept current while on screen (answered here or elsewhere).
  $: rec = shown != null ? $coachRecommendations.find(r => r.id === shown) : null;
</script>

{#if rec}
  <TargetsCard {rec} compact dismissible coachName={coachNameFor($coachingState, rec.pairing_id)}
    on:dismiss={() => shown = null} on:answered={() => loadCoachRecommendations()} />
{/if}
