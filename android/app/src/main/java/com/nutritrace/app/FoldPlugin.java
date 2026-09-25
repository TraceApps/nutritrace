package com.nutritrace.app;

import android.graphics.Rect;
import android.view.View;

import androidx.core.content.ContextCompat;
import androidx.core.util.Consumer;
import androidx.window.java.layout.WindowInfoTrackerCallbackAdapter;
import androidx.window.layout.DisplayFeature;
import androidx.window.layout.FoldingFeature;
import androidx.window.layout.WindowInfoTracker;
import androidx.window.layout.WindowLayoutInfo;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Tells the app where a foldable's fold is and how far it's open, so layouts
 * can keep content off the crease (book posture) or split above and below it
 * (tabletop). Bounds are in CSS pixels relative to the WebView.
 */
@CapacitorPlugin(name = "Fold")
public class FoldPlugin extends Plugin {
    private WindowInfoTrackerCallbackAdapter tracker;
    private final Consumer<WindowLayoutInfo> listener = this::onLayout;
    private JSObject last = emptyState();

    @Override
    public void load() {
        tracker = new WindowInfoTrackerCallbackAdapter(WindowInfoTracker.getOrCreate(getActivity()));
        tracker.addWindowLayoutInfoListener(getActivity(), ContextCompat.getMainExecutor(getContext()), listener);
    }

    @Override
    protected void handleOnDestroy() {
        if (tracker != null) tracker.removeWindowLayoutInfoListener(listener);
    }

    @PluginMethod
    public void getState(PluginCall call) {
        call.resolve(last);
    }

    private static JSObject emptyState() {
        JSObject o = new JSObject();
        o.put("features", new JSArray());
        return o;
    }

    private void onLayout(WindowLayoutInfo info) {
        float density = getContext().getResources().getDisplayMetrics().density;
        int[] offset = new int[2];
        View web = getBridge() != null ? getBridge().getWebView() : null;
        if (web != null) web.getLocationInWindow(offset);
        JSArray features = new JSArray();
        for (DisplayFeature feature : info.getDisplayFeatures()) {
            if (!(feature instanceof FoldingFeature)) continue;
            FoldingFeature fold = (FoldingFeature) feature;
            Rect b = fold.getBounds();
            JSObject o = new JSObject();
            o.put("state", fold.getState() == FoldingFeature.State.HALF_OPENED ? "half_opened" : "flat");
            o.put("orientation", fold.getOrientation() == FoldingFeature.Orientation.VERTICAL ? "vertical" : "horizontal");
            o.put("separating", fold.isSeparating());
            o.put("left", (b.left - offset[0]) / density);
            o.put("top", (b.top - offset[1]) / density);
            o.put("right", (b.right - offset[0]) / density);
            o.put("bottom", (b.bottom - offset[1]) / density);
            features.put(o);
        }
        JSObject out = new JSObject();
        out.put("features", features);
        last = out;
        notifyListeners("change", out, true);
    }
}
