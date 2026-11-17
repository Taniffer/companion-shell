package org.companion.capture;

import android.app.Service;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.IBinder;
import android.provider.Settings;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.TextView;

public final class OverlayService extends Service {
    public static volatile boolean running=false;
    private WindowManager manager; private TextView bubble; private WindowManager.LayoutParams params;
    private int dp(int n){return Math.round(n*getResources().getDisplayMetrics().density);}
    @Override public IBinder onBind(Intent intent){return null;}
    @Override public int onStartCommand(Intent intent,int flags,int id){
        if(intent!=null&&"stop".equals(intent.getAction())){stopSelf();return START_NOT_STICKY;}
        if(!Settings.canDrawOverlays(this)){stopSelf();return START_NOT_STICKY;}
        NotificationManager notifications=(NotificationManager)getSystemService(NOTIFICATION_SERVICE);
        notifications.createNotificationChannel(new NotificationChannel("capture-overlay","随手记悬浮入口",NotificationManager.IMPORTANCE_LOW));
        PendingIntent open=PendingIntent.getActivity(this,1,new Intent(this,QuickCaptureActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK|Intent.FLAG_ACTIVITY_CLEAR_TOP|Intent.FLAG_ACTIVITY_SINGLE_TOP),PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stop=PendingIntent.getService(this,2,new Intent(this,OverlayService.class).setAction("stop"),PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
        Notification notification=new Notification.Builder(this,"capture-overlay").setSmallIcon(R.drawable.ic_capture).setContentTitle("记一下 · 随时留下想法").setContentText("点悬浮图标记录；长按图标或点此通知关闭入口。").setContentIntent(open).setOngoing(true).setShowWhen(false).addAction(new Notification.Action.Builder(null,"关闭悬浮入口",stop).build()).build();
        if(Build.VERSION.SDK_INT>=34)startForeground(4201,notification,ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);else startForeground(4201,notification);
        if(bubble!=null)return START_NOT_STICKY;
        manager=(WindowManager)getSystemService(WINDOW_SERVICE);
        bubble=new TextView(this);bubble.setText("记");bubble.setTextSize(19);bubble.setTypeface(null,Typeface.BOLD);bubble.setTextColor(Color.WHITE);bubble.setGravity(Gravity.CENTER);bubble.setContentDescription("记一下，打开记录面板");
        GradientDrawable shape=new GradientDrawable();shape.setColor(Color.parseColor("#24766B"));shape.setCornerRadius(dp(24));shape.setStroke(dp(2),Color.parseColor("#E6F1EA"));bubble.setBackground(shape);bubble.setElevation(dp(7));
        params=new WindowManager.LayoutParams(dp(48),dp(48),WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,PixelFormat.TRANSLUCENT);params.gravity=Gravity.TOP|Gravity.LEFT;
        params.x=getSharedPreferences("overlay",0).getInt("x",Math.max(0,getResources().getDisplayMetrics().widthPixels-dp(60)));params.y=getSharedPreferences("overlay",0).getInt("y",dp(240));
        bubble.setOnClickListener(v->{try{startActivity(new Intent(this,QuickCaptureActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK|Intent.FLAG_ACTIVITY_CLEAR_TOP));}catch(Exception ignored){}});
        bubble.setOnLongClickListener(v->{stopSelf();return true;});
        bubble.setOnTouchListener(new View.OnTouchListener(){float startX,startY;int oldX,oldY;boolean moved;long down;
            public boolean onTouch(View view,MotionEvent event){if(event.getAction()==MotionEvent.ACTION_DOWN){startX=event.getRawX();startY=event.getRawY();oldX=params.x;oldY=params.y;moved=false;down=System.currentTimeMillis();return true;}
                if(event.getAction()==MotionEvent.ACTION_MOVE){int dx=(int)(event.getRawX()-startX),dy=(int)(event.getRawY()-startY);if(Math.abs(dx)+Math.abs(dy)>dp(6))moved=true;if(moved){params.x=Math.max(0,Math.min(getResources().getDisplayMetrics().widthPixels-dp(48),oldX+dx));params.y=Math.max(0,Math.min(getResources().getDisplayMetrics().heightPixels-dp(70),oldY+dy));try{manager.updateViewLayout(bubble,params);}catch(Exception ignored){stopSelf();}}return true;}
                if(event.getAction()==MotionEvent.ACTION_UP){if(!moved){if(System.currentTimeMillis()-down>650)view.performLongClick();else view.performClick();}else getSharedPreferences("overlay",0).edit().putInt("x",params.x).putInt("y",params.y).apply();return true;}return false;}});
        try{manager.addView(bubble,params);running=true;}catch(Exception error){bubble=null;stopSelf();}
        return START_NOT_STICKY;
    }
    @Override public void onDestroy(){running=false;if(bubble!=null&&manager!=null)try{manager.removeView(bubble);}catch(Exception ignored){}bubble=null;stopForeground(true);super.onDestroy();}
}
