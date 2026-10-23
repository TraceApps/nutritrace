<script>
  // The coach's plan for the day on show, on the Diary. Its meals count as
  // logged from the day's own items, so deleting them brings Log This back.
  // Nothing for anyone without a coach (the Diary only mounts this for them).
  import { coachingState, coachRecommendations } from '../../stores/coaching.js';
  import { currentDate, currentEntry } from '../../stores/diary.js';
  import { loggedItems } from '../../lib/coach-plans.js';
  import { coachNameFor } from '../../lib/coaching-view.js';
  import PlanCard from './PlanCard.svelte';

  // The newest plan for this day (a replaced or withdrawn one is history).
  $: rec = ($coachRecommendations || []).find(r => r.kind === 'day_plan' && r.date === $currentDate && r.status !== 'replaced' && r.status !== 'withdrawn') || null;
  // Logging waits for the day's own entry, so nothing shows as not logged
  // while it loads.
  $: ready = !!rec && $currentEntry?.date === rec.date;
  $: logged = ready ? loggedItems($currentEntry.items, rec.id) : null;
</script>

{#if rec}
  <PlanCard {rec} diary {logged} compact coachName={coachNameFor($coachingState, rec.pairing_id)} />
{/if}
