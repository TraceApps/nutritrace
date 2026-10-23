<script>
  // A coach's recommendation, as its own card: targets, a day plan, or a
  // meal or recipe sent to the client.
  import TargetsCard from './TargetsCard.svelte';
  import PlanCard from './PlanCard.svelte';
  import MealRecCard from './MealRecCard.svelte';

  export let rec;
  export let coachName = '';
  export let compact = false;
  export let coachView = false;
  export let mealNames = null;
</script>

{#if rec.kind === 'day_plan'}
  <PlanCard {rec} {coachName} {compact} {coachView} {mealNames} on:answered />
{:else if rec.kind === 'meal' || rec.kind === 'recipe'}
  <MealRecCard {rec} {coachName} {compact} {coachView} on:answered />
{:else}
  <TargetsCard {rec} {coachName} {compact} {coachView} on:answered />
{/if}
