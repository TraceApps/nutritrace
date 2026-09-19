<script>
  import SettingsWebhooks from '../../components/settings/SettingsWebhooks.svelte';
</script>

<!-- Passing expanded=true so the child eagerly loads on sub-page mount
     (the same signal the accordion used to fire when the drawer opened). -->
<SettingsWebhooks expanded={true} />
