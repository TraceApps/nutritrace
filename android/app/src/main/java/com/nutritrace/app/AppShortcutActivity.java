package com.nutritrace.app;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

/**
 * The app icon's shortcuts (res/xml/shortcuts.xml) open this first, and it
 * hands their link to the app.
 *
 * Launchers start a shortcut with FLAG_ACTIVITY_NEW_TASK and
 * FLAG_ACTIVITY_CLEAR_TASK. Aimed at MainActivity, that cleared the app's own
 * task: the running app closed and started again, its page reloaded, and a
 * change still waiting to save could be lost. This activity lives in a task
 * of its own (taskAffinity ""), shows nothing (Theme.NoDisplay), stays out of
 * Recents and finishes at once, so the launcher only clears that empty task.
 *
 * MainActivity is singleTask: when the app is running, it gets the link in
 * onNewIntent (Capacitor's appUrlOpen) with its page as it was; when it isn't,
 * it starts with the link as the launch URL. Only a LINK_SCHEME://new/<kind>
 * link goes on, rebuilt with nothing else from the intent; anything else just
 * opens the app.
 *
 * The same file is in NutriTrace, LiftTrace, CookTrace and NoteTrace; only the
 * package line differs, and scripts/app-shortcut-activity.test.js in every app
 * pins its hash. Change all four copies together, then every app's hash.
 */
public class AppShortcutActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Intent in = getIntent();
        startActivity(forward(this, in == null ? null : in.getData()));
        finish();
        overridePendingTransition(0, 0);
    }

    /** The intent that takes a shortcut's link on to MainActivity. */
    static Intent forward(Context context, Uri link) {
        Intent out = new Intent(context, MainActivity.class);
        String kind = shortcutKind(link);
        if (kind != null) {
            out.setAction(Intent.ACTION_VIEW);
            out.setData(Uri.parse(MainActivity.LINK_SCHEME + "://new/" + kind));
        } else {
            out.setAction(Intent.ACTION_MAIN);
            out.addCategory(Intent.CATEGORY_LAUNCHER);
        }
        // NEW_TASK reaches the app's own task from this one. MainActivity is
        // singleTask, so the running one gets onNewIntent; CLEAR_TOP and
        // SINGLE_TOP ask for the same, so it is never started a second time.
        // Never CLEAR_TASK: that is what restarted the app.
        out.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return out;
    }

    /** The <kind> of a LINK_SCHEME://new/<kind> link, in lower case, or null. */
    static String shortcutKind(Uri link) {
        if (link == null) return null;
        if (!MainActivity.LINK_SCHEME.equalsIgnoreCase(link.getScheme())) return null;
        if (!"new".equalsIgnoreCase(link.getHost())) return null;
        String path = link.getPath();
        if (path == null || !path.matches("/[A-Za-z]+/?")) return null;
        return path.replace("/", "").toLowerCase(java.util.Locale.ROOT);
    }

    /**
     * MainActivity calls this before super.onCreate. When a shortcut started
     * the app, its link stays in the app's task, and Android hands it back
     * when the app is opened again from Recents after it was closed in the
     * background (or rebuilt from saved state). That isn't a new tap, so the
     * link is dropped there and the app opens as it does from its icon.
     * Sign-in return links, shared files and every other intent are left as
     * they are.
     */
    static void dropReplayedLink(Activity activity, Bundle savedInstanceState) {
        Intent in = activity.getIntent();
        if (in == null || shortcutKind(in.getData()) == null) return;
        boolean fromRecents = (in.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0;
        if (!fromRecents && savedInstanceState == null) return;
        Intent plain = new Intent(in);
        plain.setAction(Intent.ACTION_MAIN);
        plain.setData(null);
        activity.setIntent(plain);
    }
}
