package it.arcadrive.mobile;

import android.content.Context;
import android.graphics.Matrix;
import android.graphics.RectF;
import android.graphics.drawable.Drawable;
import android.view.GestureDetector;
import android.view.MotionEvent;
import android.view.ScaleGestureDetector;
import android.widget.ImageView;

/** ImageView con zoom e trascinamento, senza dipendenze esterne. */
public final class ZoomImageView extends ImageView {
    public interface HorizontalSwipeListener { void onSwipe(int direction); }

    private static final float MIN_SCALE = 1f;
    private static final float MAX_SCALE = 5f;
    private final Matrix imageMatrix = new Matrix();
    private final float[] matrixValues = new float[9];
    private final ScaleGestureDetector scaleDetector;
    private final GestureDetector gestureDetector;
    private float scale = MIN_SCALE;
    private float baseScale = 1f;
    private float lastX;
    private float lastY;
    private boolean dragging;
    private HorizontalSwipeListener swipeListener;

    public ZoomImageView(Context context) {
        super(context);
        super.setScaleType(ScaleType.MATRIX);
        setClickable(true);
        scaleDetector = new ScaleGestureDetector(context, new ScaleGestureDetector.SimpleOnScaleGestureListener() {
            @Override public boolean onScaleBegin(ScaleGestureDetector detector) {
                getParent().requestDisallowInterceptTouchEvent(true);
                return true;
            }

            @Override public boolean onScale(ScaleGestureDetector detector) {
                float target = clamp(scale * detector.getScaleFactor(), MIN_SCALE, MAX_SCALE);
                float factor = target / scale;
                scale = target;
                imageMatrix.postScale(factor, factor, detector.getFocusX(), detector.getFocusY());
                constrainTranslation();
                setImageMatrix(imageMatrix);
                return true;
            }
        });
        gestureDetector = new GestureDetector(context, new GestureDetector.SimpleOnGestureListener() {
            @Override public boolean onDown(MotionEvent event) { return true; }

            @Override public boolean onDoubleTap(MotionEvent event) {
                if (scale > MIN_SCALE + .05f) resetZoom();
                else zoomTo(2.5f, event.getX(), event.getY());
                return true;
            }

            @Override public boolean onFling(MotionEvent start, MotionEvent end, float velocityX, float velocityY) {
                if (scale <= MIN_SCALE + .01f && swipeListener != null && Math.abs(velocityX) > Math.abs(velocityY) * 1.25f && Math.abs(velocityX) > 650f) {
                    swipeListener.onSwipe(velocityX < 0 ? 1 : -1);
                    return true;
                }
                return false;
            }
        });
    }

    public void setHorizontalSwipeListener(HorizontalSwipeListener listener) { swipeListener = listener; }
    public boolean isZoomed() { return scale > MIN_SCALE + .01f; }

    @Override public void setScaleType(ScaleType type) {
        if (type != ScaleType.MATRIX) throw new IllegalArgumentException("ZoomImageView usa sempre MATRIX");
        super.setScaleType(type);
    }

    @Override protected void onSizeChanged(int width, int height, int oldWidth, int oldHeight) {
        super.onSizeChanged(width, height, oldWidth, oldHeight);
        configureBaseMatrix();
    }

    @Override public void setImageDrawable(Drawable drawable) {
        super.setImageDrawable(drawable);
        post(this::configureBaseMatrix);
    }

    @Override public boolean onTouchEvent(MotionEvent event) {
        scaleDetector.onTouchEvent(event);
        gestureDetector.onTouchEvent(event);
        switch (event.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                lastX = event.getX(); lastY = event.getY(); dragging = false;
                if (isZoomed()) getParent().requestDisallowInterceptTouchEvent(true);
                break;
            case MotionEvent.ACTION_POINTER_DOWN:
                getParent().requestDisallowInterceptTouchEvent(true);
                break;
            case MotionEvent.ACTION_MOVE:
                if (!scaleDetector.isInProgress() && isZoomed()) {
                    float dx = event.getX() - lastX;
                    float dy = event.getY() - lastY;
                    if (Math.abs(dx) > 1f || Math.abs(dy) > 1f) dragging = true;
                    imageMatrix.postTranslate(dx, dy);
                    constrainTranslation();
                    setImageMatrix(imageMatrix);
                    getParent().requestDisallowInterceptTouchEvent(true);
                } else if (!scaleDetector.isInProgress()) {
                    getParent().requestDisallowInterceptTouchEvent(false);
                }
                lastX = event.getX(); lastY = event.getY();
                break;
            case MotionEvent.ACTION_UP:
            case MotionEvent.ACTION_CANCEL:
                if (!dragging) performClick();
                getParent().requestDisallowInterceptTouchEvent(false);
                break;
        }
        return true;
    }

    @Override public boolean performClick() { super.performClick(); return true; }

    private void configureBaseMatrix() {
        Drawable drawable = getDrawable();
        if (drawable == null || getWidth() == 0 || getHeight() == 0 || drawable.getIntrinsicWidth() <= 0 || drawable.getIntrinsicHeight() <= 0) return;
        float fit = Math.min(getWidth() / (float) drawable.getIntrinsicWidth(), getHeight() / (float) drawable.getIntrinsicHeight());
        baseScale = fit;
        float dx = (getWidth() - drawable.getIntrinsicWidth() * fit) / 2f;
        float dy = (getHeight() - drawable.getIntrinsicHeight() * fit) / 2f;
        imageMatrix.reset(); imageMatrix.postScale(fit, fit); imageMatrix.postTranslate(dx, dy);
        scale = MIN_SCALE; setImageMatrix(imageMatrix);
    }

    private void resetZoom() { configureBaseMatrix(); }

    private void zoomTo(float target, float focusX, float focusY) {
        target = clamp(target, MIN_SCALE, MAX_SCALE);
        float factor = target / scale; scale = target;
        imageMatrix.postScale(factor, factor, focusX, focusY);
        constrainTranslation(); setImageMatrix(imageMatrix);
    }

    private void constrainTranslation() {
        Drawable drawable = getDrawable(); if (drawable == null) return;
        RectF bounds = new RectF(0, 0, drawable.getIntrinsicWidth(), drawable.getIntrinsicHeight()); imageMatrix.mapRect(bounds);
        float dx = bounds.width() <= getWidth() ? (getWidth() - bounds.width()) / 2f - bounds.left : bounds.left > 0 ? -bounds.left : bounds.right < getWidth() ? getWidth() - bounds.right : 0;
        float dy = bounds.height() <= getHeight() ? (getHeight() - bounds.height()) / 2f - bounds.top : bounds.top > 0 ? -bounds.top : bounds.bottom < getHeight() ? getHeight() - bounds.bottom : 0;
        imageMatrix.postTranslate(dx, dy);
    }

    private static float clamp(float value, float minimum, float maximum) { return Math.max(minimum, Math.min(maximum, value)); }
}
