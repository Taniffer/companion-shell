package org.companion.capture;

import android.app.Activity;
import android.content.Intent;
import android.content.ClipData;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowInsets;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.text.DateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity implements Importer.Listener {
    private static final ExecutorService NETWORK=Executors.newSingleThreadExecutor();
    private LinearLayout root,body;
    private EditText note,pairText;
    private TextView status,attachmentLabel;
    private ScrollView scroll;
    private JSONArray attachments=new JSONArray();
    private String draft="",source="android",screen="capture",pairDraft="";
    private String draftId=UUID.randomUUID().toString();
    private boolean fromShare=false,saving=false,night=false,awaitingOverlay=false;
    private int ink,muted,paper,background,accent;
    private final int PICK_IMAGE=3101;
    private int dp(int value){return Math.round(value*getResources().getDisplayMetrics().density);}
    @Override public void onCreate(Bundle bundle){
        night=(getResources().getConfiguration().uiMode&Configuration.UI_MODE_NIGHT_MASK)==Configuration.UI_MODE_NIGHT_YES;
        setTheme(night?android.R.style.Theme_Material_NoActionBar:android.R.style.Theme_Material_Light_NoActionBar);
        super.onCreate(bundle);
        ink=Color.parseColor(night?"#E6EFE9":"#25372E");muted=Color.parseColor(night?"#A9BBB1":"#64756A");paper=Color.parseColor(night?"#222C26":"#FFFFFF");background=Color.parseColor(night?"#18221C":"#F5F4F0");accent=Color.parseColor(night?"#A8D8B9":"#24766B");
        if(bundle!=null){draft=bundle.getString("draft","");screen=bundle.getString("screen","capture");pairDraft=bundle.getString("pairDraft","");draftId=bundle.getString("draftId",draftId);source=bundle.getString("source","android");fromShare=bundle.getBoolean("fromShare",false);try{attachments=new JSONArray(bundle.getString("attachments","[]"));}catch(Exception ignored){}}
        else {if(Intent.ACTION_MAIN.equals(getIntent().getAction()))try(RecordStore store=new RecordStore(this)){ArrayList<JSONObject> drafts=store.drafts();for(JSONObject existing:drafts)if(!existing.optString("source").equals("android-floating")){loadDraft(existing);break;}}catch(Exception ignored){}receive(getIntent());}
        try(RecordStore store=new RecordStore(this)){if(store.saved(draftId)){draftId=UUID.randomUUID().toString();draft="";attachments=new JSONArray();source="android";fromShare=false;}}catch(Exception ignored){}
        draw();Sync.schedule(this);
    }
    @Override protected void onNewIntent(Intent intent){super.onNewIntent(intent);setIntent(intent);stash();receive(intent);draw();}
    @Override protected void onSaveInstanceState(Bundle state){stash();state.putString("draft",draft);state.putString("screen",screen);state.putString("pairDraft",pairDraft);state.putString("draftId",draftId);state.putString("source",source);state.putString("attachments",attachments.toString());state.putBoolean("fromShare",fromShare);super.onSaveInstanceState(state);}
    @Override protected void onResume(){super.onResume();try(RecordStore records=new RecordStore(this)){if(records.saved(draftId)){draftId=UUID.randomUUID().toString();draft="";attachments=new JSONArray();source="android";fromShare=false;if(note!=null)note.setText("");}}catch(Exception ignored){}if(awaitingOverlay){awaitingOverlay=false;if(android.provider.Settings.canDrawOverlays(this))startOverlay();else toast("悬浮入口未开启，仍可用系统分享记一下");}Importer.listen(this);refreshImages();stash();draw();try(RecordStore store=new RecordStore(this)){if(store.pendingCount()>0)sync();}catch(Exception ignored){}}
    @Override protected void onPause(){stash();Importer.detach(this);super.onPause();}
    private void stash(){if(note!=null)draft=note.getText().toString();if(pairText!=null)pairDraft=pairText.getText().toString();try(RecordStore store=new RecordStore(this)){if(!draft.isEmpty()||attachments.length()>0||Importer.busy(draftId))store.putDraft(draftId,draft,source,attachments);else store.deleteDraftIfEmpty(draftId);}catch(Exception ignored){}}
    private void loadDraft(JSONObject value)throws Exception{draftId=value.getString("id");draft=value.optString("text");source=value.optString("source","android");attachments=value.optJSONArray("attachments");if(attachments==null)attachments=new JSONArray();}
    private void refreshImages(){try(RecordStore store=new RecordStore(this)){JSONObject value=store.draft(draftId);if(value!=null&&value.optJSONArray("attachments")!=null)attachments=value.getJSONArray("attachments");}catch(Exception ignored){}}
    @Override public void imported(String id,String error){if(!id.equals(draftId))return;refreshImages();stash();draw();if(!error.isEmpty())toast(error);}
    private void receive(Intent intent){
        if(intent==null)return;
        if(Intent.ACTION_VIEW.equals(intent.getAction())&&intent.getData()!=null){pairDraft=intent.getData().toString();screen="pair";return;}
        if(!Intent.ACTION_SEND.equals(intent.getAction())&&!Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction()))return;
        draftId=UUID.randomUUID().toString();draft="";attachments=new JSONArray();note=null;pairText=null;
        fromShare=true;screen="capture";source="android-share";
        CharSequence shared=intent.getCharSequenceExtra(Intent.EXTRA_TEXT);String subject=intent.getStringExtra(Intent.EXTRA_SUBJECT);
        if(shared!=null)draft=shared.toString();else if(subject!=null)draft=subject;
        try{
            ArrayList<Uri> images=new ArrayList<>();
            if(Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction())){ArrayList<Uri> values=intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);if(values!=null)images.addAll(values);}
            else {Uri image=intent.getParcelableExtra(Intent.EXTRA_STREAM);if(image!=null)images.add(image);}
            if(images.isEmpty()&&intent.getClipData()!=null&&intent.getType()!=null&&intent.getType().startsWith("image/")){ClipData clips=intent.getClipData();for(int i=0;i<clips.getItemCount();i++)if(clips.getItemAt(i).getUri()!=null)images.add(clips.getItemAt(i).getUri());}
            if(images.size()>3)throw new Exception("一次最多登记 3 张图片");
            stash();if(!images.isEmpty())importImages(images);
        }catch(Exception e){toast(Sync.safe(e));}
    }
    private void importImages(ArrayList<Uri> images){try(RecordStore store=new RecordStore(this)){store.putDraft(draftId,draft,source,attachments);Importer.add(this,draftId,images);}catch(Exception e){toast("图片尚未导入，请重新选择");}}
    private TextView label(String text,int size,int color){TextView view=new TextView(this);view.setText(text);view.setTextSize(size);view.setTextColor(color);view.setLineSpacing(dp(3),1);return view;}
    private void gap(LinearLayout parent,int height){View view=new View(this);parent.addView(view,new LinearLayout.LayoutParams(1,dp(height)));}
    private GradientDrawable surface(int color){GradientDrawable drawable=new GradientDrawable();drawable.setColor(color);drawable.setCornerRadius(dp(12));return drawable;}
    private Button button(String text,Runnable action,boolean primary){Button value=new Button(this);value.setText(text);value.setAllCaps(false);value.setMinHeight(dp(48));value.setTextColor(primary?(night?Color.parseColor("#183D28"):Color.WHITE):ink);value.setBackground(surface(primary?accent:paper));value.setPadding(dp(12),dp(8),dp(12),dp(8));value.setOnClickListener(v->action.run());return value;}
    private void draw(){
        note=null;pairText=null;
        root=new LinearLayout(this);root.setOrientation(LinearLayout.VERTICAL);root.setBackgroundColor(background);
        root.setPadding(dp(20),dp(18),dp(20),dp(12));
        root.setOnApplyWindowInsetsListener((view,insets)->{int top=insets.getSystemWindowInsetTop(),bottom=insets.getSystemWindowInsetBottom();root.setPadding(dp(20)+insets.getSystemWindowInsetLeft(),dp(18)+top,dp(20)+insets.getSystemWindowInsetRight(),dp(12)+bottom);return insets;});
        getWindow().setStatusBarColor(background);getWindow().setNavigationBarColor(background);if(!night)getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
        TextView title=label(screen.equals("pair")?"连接电脑":screen.equals("history")?"我的记录":"记一下",27,ink);title.setTypeface(null,Typeface.BOLD);root.addView(title);gap(root,4);
        root.addView(label(screen.equals("capture")?"留住眼前这一点，之后接着用。":screen.equals("pair")?"配对一次，记录就能送到你的电脑。":"已保存的内容，不会因离线丢失。",14,muted));gap(root,18);
        scroll=new ScrollView(this);scroll.setFillViewport(true);body=new LinearLayout(this);body.setOrientation(LinearLayout.VERTICAL);scroll.addView(body);root.addView(scroll,new LinearLayout.LayoutParams(-1,0,1));
        if(screen.equals("pair"))drawPair();else if(screen.equals("history"))drawHistory();else drawCapture();
        gap(root,12);LinearLayout navigation=new LinearLayout(this);String[] labels={"记一下","记录","连接"};String[] screens={"capture","history","pair"};for(int i=0;i<3;i++){final String destination=screens[i];Button entry=button(labels[i],()->{stash();screen=destination;draw();},screen.equals(destination));LinearLayout.LayoutParams layout=new LinearLayout.LayoutParams(0,dp(48),1);if(i>0)layout.leftMargin=dp(7);navigation.addView(entry,layout);}root.addView(navigation);setContentView(root);
    }
    private void toggleOverlay(){if(OverlayService.running){stopService(new Intent(this,OverlayService.class));toast("悬浮入口已关闭");draw();return;}if(!android.provider.Settings.canDrawOverlays(this)){awaitingOverlay=true;try{startActivityForResult(new Intent(android.provider.Settings.ACTION_MANAGE_OVERLAY_PERMISSION,Uri.parse("package:"+getPackageName())),3102);}catch(Exception error){awaitingOverlay=false;toast("请在系统应用设置中允许显示在其他应用上层");}return;}startOverlay();}
    private void startOverlay(){try{if(Build.VERSION.SDK_INT>=33&&checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)!=android.content.pm.PackageManager.PERMISSION_GRANTED&&!getSharedPreferences("overlay",0).getBoolean("notificationAsked",false)){getSharedPreferences("overlay",0).edit().putBoolean("notificationAsked",true).apply();requestPermissions(new String[]{android.Manifest.permission.POST_NOTIFICATIONS},3103);}startForegroundService(new Intent(this,OverlayService.class));toast("已开启；点图标记录，长按图标关闭");}catch(Exception error){toast("悬浮入口尚未开启，请保持应用在前台后重试");}}
    private void drawCapture(){
        body.addView(button(OverlayService.running?"关闭悬浮入口":"开启悬浮记录入口",this::toggleOverlay,false));gap(body,12);
        note=new EditText(this);note.setText(draft);note.setHint("一段话、一个链接，或者刚刚的想法……");note.setTextSize(17);note.setTextColor(ink);note.setHintTextColor(muted);note.setGravity(android.view.Gravity.TOP);note.setMinLines(6);note.setPadding(dp(15),dp(14),dp(15),dp(14));note.setBackground(surface(paper));body.addView(note,new LinearLayout.LayoutParams(-1,-2));gap(body,12);
        attachmentLabel=label(Importer.busy(draftId)?"正在导入图片，请稍候……":attachments.length()>0?"已附上 "+attachments.length()+" 张图片":"可从其他应用分享文字、链接或图片到这里",13,muted);body.addView(attachmentLabel);gap(body,12);
        Button addImage=button("添加图片",()->{stash();Intent choose=new Intent(Intent.ACTION_OPEN_DOCUMENT);choose.setType("image/*");choose.addCategory(Intent.CATEGORY_OPENABLE);startActivityForResult(choose,PICK_IMAGE);},false);addImage.setEnabled(!Importer.busy(draftId));body.addView(addImage);gap(body,14);
        if(attachments.length()>0&&!Importer.busy(draftId)){body.addView(button("移除本次图片",()->{stash();attachments=new JSONArray();try(RecordStore store=new RecordStore(this)){store.clearDraftImages(draftId);}catch(Exception ignored){}stash();draw();},false));gap(body,12);}
        Button save=button("记下",this::save,true);save.setEnabled(!Importer.busy(draftId));body.addView(save);gap(body,16);status=label(connectionDescription(),13,muted);body.addView(status);
    }
    private String connectionDescription(){try(RecordStore store=new RecordStore(this)){JSONObject connection=Connection.load(this);return connection==null?"先留在手机，之后连接电脑。":("已连接 "+new java.net.URL(connection.getString("url")).getHost()+" · "+store.pendingCount()+" 条待同步");}catch(Exception e){return "记录保存在手机，可重新连接电脑。";}}
    private void save(){
        if(saving)return;if(Importer.busy(draftId)){toast("图片正在导入，请稍候再记下");return;}refreshImages();stash();if(draft.trim().isEmpty()&&attachments.length()==0){toast("写一点内容或添加一张图片");return;}if(draft.length()>20000){toast("文字最多 20000 字，请分成几条登记");return;}
        saving=true;
        try(RecordStore store=new RecordStore(this)){store.save(draftId,draft.trim(),source,new JSONArray(attachments.toString()));draftId=UUID.randomUUID().toString();draft="";if(note!=null)note.setText("");attachments=new JSONArray();source="android";toast("已记下");Sync.schedule(this);sync();if(fromShare){finish();return;}draw();}
        catch(Exception e){toast("还没保存成功："+Sync.safe(e));}
        finally{saving=false;}
    }
    private void drawHistory(){
        body.addView(button("现在同步",this::sync,false));gap(body,12);status=label(connectionDescription(),13,muted);body.addView(status);gap(body,14);
        try(RecordStore store=new RecordStore(this)){
            for(JSONObject saved:store.drafts()){final String id=saved.getString("id");if(saved.optString("text").isEmpty()&&saved.optJSONArray("attachments").length()==0)continue;body.addView(label("未登记草稿 · "+saved.optString("text","图片").substring(0,Math.min(80,saved.optString("text","图片").length())),14,muted));body.addView(button("继续这条草稿",()->{stash();try(RecordStore drafts=new RecordStore(this)){loadDraft(drafts.draft(id));screen="capture";fromShare=false;draw();}catch(Exception e){toast("暂时无法打开草稿");}},false));gap(body,12);}
            ArrayList<JSONObject> entries=store.list(false,60);if(entries.isEmpty()){body.addView(label("还没有记录。随时写一句，或从其他应用分享进来。",16,muted));return;}
            for(JSONObject item:entries){LinearLayout row=new LinearLayout(this);row.setOrientation(LinearLayout.VERTICAL);row.setPadding(dp(14),dp(12),dp(14),dp(12));row.setBackground(surface(paper));String value=item.optString("text");if(value.isEmpty())value="图片记录";row.addView(label(value.length()>240?value.substring(0,240)+"…":value,16,ink));gap(row,7);String info=DateFormat.getDateTimeInstance(DateFormat.SHORT,DateFormat.SHORT).format(new Date(item.getLong("createdAt")))+" · "+(item.optBoolean("synced")?"已送到电脑":item.optBoolean("paused")?"仅留手机，需要处理":"留在手机，待同步");row.addView(label(info,12,muted));if(!item.optString("error").isEmpty())row.addView(label(item.optString("error"),12,muted));if(item.optBoolean("paused")){final String id=item.getString("id");row.addView(button("重新尝试同步这条",()->{try(RecordStore records=new RecordStore(this)){records.retry(id);sync();}catch(Exception e){toast("暂时无法重试");}},false));}body.addView(row);gap(body,10);}
        }catch(Exception e){body.addView(label("暂时无法读取记录，请重新打开应用。",15,muted));}
    }
    private void drawPair(){
        body.addView(label("在电脑工作台打开“连接手机”，复制配对信息，粘贴到这里。手机和电脑需要能互相连接，例如同一 Wi-Fi。",16,ink));gap(body,15);
        pairText=new EditText(this);pairText.setText(pairDraft);pairText.setHint("companion://pair?…");pairText.setTextColor(ink);pairText.setTextSize(15);pairText.setMinLines(4);pairText.setPadding(dp(12),dp(12),dp(12),dp(12));pairText.setBackground(surface(paper));body.addView(pairText);gap(body,12);body.addView(button("连接这台电脑",this::pair,true));gap(body,15);status=label(connectionDescription(),14,muted);body.addView(status);gap(body,12);body.addView(label("只登记你主动留下的内容。应用不读取其他应用的消息。悬浮入口需要显示上层权限，通知只用于保留入口。",13,muted));
    }
    private void pair(){
        stash();String provided=pairDraft.trim();java.util.regex.Matcher match=java.util.regex.Pattern.compile("companion://pair\\?[^\\s]+").matcher(provided);final String code=match.find()?match.group():provided;status.setText("正在核对电脑……");
        NETWORK.execute(()->{try{
            Uri uri=Uri.parse(code);if(!"companion".equals(uri.getScheme())||!"pair".equals(uri.getHost()))throw new Exception("请粘贴电脑生成的完整配对信息");
            String url=uri.getQueryParameter("url"),pin=uri.getQueryParameter("pin"),ticket=uri.getQueryParameter("ticket");if(url==null||pin==null||ticket==null)throw new Exception("配对信息不完整，请重新复制");
            JSONObject config=new JSONObject();config.put("url",url);config.put("pin",pin);
            android.content.SharedPreferences identity=getSharedPreferences("identity",0);String id=identity.getString("id",null);if(id==null){id=UUID.randomUUID().toString();identity.edit().putString("id",id).commit();}
            JSONObject request=new JSONObject();request.put("ticket",ticket);request.put("deviceId",id);request.put("deviceName",Build.MANUFACTURER+" "+Build.MODEL);
            JSONObject result=Connection.post(config,"/mobile/pair",request);config.put("token",result.getString("token"));config.put("deviceId",result.getString("deviceId"));Connection.save(this,config);
            runOnUiThread(()->{if(isFinishing()||isDestroyed())return;stash();pairDraft="";if(screen.equals("pair")){screen="capture";draw();}toast("已连接电脑");sync();});
        }catch(Exception e){runOnUiThread(()->{if(status!=null)status.setText(Sync.safe(e));});}});
    }
    private void sync(){NETWORK.execute(()->{String result=Sync.run(getApplicationContext());runOnUiThread(()->{if(!isFinishing()&&!isDestroyed()){if(screen.equals("history")){int y=scroll==null?0:scroll.getScrollY();draw();scroll.post(()->scroll.scrollTo(0,y));}if(status!=null)status.setText(result);}});});}
    private void toast(String value){Toast.makeText(this,value,Toast.LENGTH_SHORT).show();}
    @Override protected void onActivityResult(int request,int result,Intent data){super.onActivityResult(request,result,data);if(request==PICK_IMAGE&&result==RESULT_OK&&data!=null){stash();ArrayList<Uri> images=new ArrayList<>();images.add(data.getData());importImages(images);screen="capture";draw();}}
}
