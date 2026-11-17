package org.companion.capture;

import android.app.Activity;
import android.content.Intent;
import android.content.ClipData;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.ColorDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.view.Gravity;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.UUID;
import java.util.concurrent.Executors;

public final class QuickCaptureActivity extends Activity implements Importer.Listener {
    private static final java.util.concurrent.ExecutorService NETWORK=Executors.newSingleThreadExecutor();
    private String id,source="android-floating";private EditText input;private JSONArray images=new JSONArray();private TextView info;private Button saveButton;private boolean saved=false,saving=false;
    private int dp(int n){return Math.round(n*getResources().getDisplayMetrics().density);}
    private GradientDrawable shape(int color,int radius){GradientDrawable d=new GradientDrawable();d.setColor(color);d.setCornerRadius(dp(radius));return d;}
    @Override public void onCreate(Bundle state){super.onCreate(state);getWindow().setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));getWindow().addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);getWindow().setDimAmount(.23f);getWindow().setGravity(Gravity.BOTTOM);getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        id=getSharedPreferences("quick-draft",0).getString("id",null);String text="";
        boolean shared=Intent.ACTION_SEND.equals(getIntent().getAction())||Intent.ACTION_SEND_MULTIPLE.equals(getIntent().getAction());
        if(state!=null){id=state.getString("id",id);source=state.getString("source",source);saved=state.getBoolean("saved",false);}else if(shared||id==null)id=UUID.randomUUID().toString();
        try(RecordStore store=new RecordStore(this)){if(saved||store.saved(id)){saved=true;finish();return;}JSONObject draft=store.draft(id);if(draft!=null){text=draft.optString("text");images=draft.optJSONArray("attachments");source=draft.optString("source",source);}}catch(Exception ignored){}
        if(images==null)images=new JSONArray();
        if(state!=null){text=state.getString("text",text);try{images=new JSONArray(state.getString("images","[]"));}catch(Exception ignored){}}
        if(shared&&state==null){source="android-share";CharSequence provided=getIntent().getCharSequenceExtra(Intent.EXTRA_TEXT);if(provided!=null)text=provided.toString();}
        getSharedPreferences("quick-draft",0).edit().putString("id",id).commit();
        LinearLayout root=new LinearLayout(this);root.setOrientation(1);root.setPadding(dp(22),dp(20),dp(22),dp(18));root.setBackground(shape(Color.parseColor("#FCFCF8"),20));
        TextView title=new TextView(this);title.setText("记一下");title.setTextSize(23);title.setTextColor(Color.parseColor("#23372D"));title.setTypeface(null,Typeface.BOLD);root.addView(title);
        TextView caption=new TextView(this);caption.setText(shared?"把这份内容留下，之后接着用。":"先记下来，之后接着用。");caption.setTextSize(12);caption.setTextColor(Color.parseColor("#748176"));caption.setPadding(0,dp(5),0,dp(15));root.addView(caption);
        input=new EditText(this);input.setText(text);input.setHint("一句话、一个链接，或眼前的想法……");input.setTextSize(16);input.setTextColor(Color.parseColor("#23372D"));input.setHintTextColor(Color.parseColor("#8C968D"));input.setMinLines(3);input.setMaxLines(6);input.setGravity(Gravity.TOP);input.setPadding(dp(13),dp(12),dp(13),dp(12));input.setBackground(shape(Color.parseColor("#EEF1EB"),10));root.addView(input,new LinearLayout.LayoutParams(-1,-2));
        info=new TextView(this);info.setTextSize(12);info.setTextColor(Color.parseColor("#748176"));info.setPadding(0,dp(12),0,dp(12));root.addView(info);
        LinearLayout actions=new LinearLayout(this);Button cancel=button("取消",false);cancel.setOnClickListener(v->finish());saveButton=button("记下",true);saveButton.setOnClickListener(v->save());LinearLayout.LayoutParams first=new LinearLayout.LayoutParams(0,dp(46),1);first.rightMargin=dp(9);actions.addView(cancel,first);actions.addView(saveButton,new LinearLayout.LayoutParams(0,dp(46),2));root.addView(actions);
        setContentView(root);getWindow().setLayout(-1,-2);stash();if(shared&&state==null)importShare();refresh();
    }
    @Override protected void onSaveInstanceState(Bundle state){stash();state.putString("id",id);state.putString("source",source);state.putString("text",input==null?"":input.getText().toString());state.putString("images",images.toString());state.putBoolean("saved",saved);super.onSaveInstanceState(state);}
    @Override protected void onNewIntent(Intent intent){super.onNewIntent(intent);if(Intent.ACTION_SEND.equals(intent.getAction())||Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction())){stash();id=UUID.randomUUID().toString();source="android-share";images=new JSONArray();saved=false;setIntent(intent);CharSequence provided=intent.getCharSequenceExtra(Intent.EXTRA_TEXT);input.setText(provided==null?"":provided.toString());getSharedPreferences("quick-draft",0).edit().putString("id",id).commit();stash();importShare();refresh();}}
    private Button button(String title,boolean primary){Button b=new Button(this);b.setText(title);b.setTextSize(14);b.setAllCaps(false);b.setTextColor(primary?Color.WHITE:Color.parseColor("#526457"));b.setBackground(shape(Color.parseColor(primary?"#24766B":"#E8EDE5"),9));return b;}
    @Override protected void onResume(){super.onResume();try(RecordStore store=new RecordStore(this)){if(id!=null&&store.saved(id)){saved=true;finish();return;}}catch(Exception ignored){}Importer.listen(this);refresh();}
    @Override protected void onPause(){stash();Importer.detach(this);super.onPause();}
    private void stash(){if(saved||input==null)return;try(RecordStore store=new RecordStore(this)){if(store.saved(id)){saved=true;return;}if(input.getText().length()>0||images.length()>0||Importer.busy(id))store.putDraft(id,input.getText().toString(),source,images);else store.deleteDraftIfEmpty(id);}catch(Exception ignored){}}
    private void refresh(){try(RecordStore store=new RecordStore(this)){JSONObject d=store.draft(id);if(d!=null&&d.optJSONArray("attachments")!=null)images=d.getJSONArray("attachments");}catch(Exception ignored){}if(info!=null)info.setText(Importer.busy(id)?"正在导入图片……":images.length()>0?"已附上 "+images.length()+" 张图片":"保存到手机，连接后自动同步");if(saveButton!=null)saveButton.setEnabled(!Importer.busy(id));}
    private void importShare(){try{ArrayList<Uri> uris=new ArrayList<>();Intent intent=getIntent();if(Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction())){ArrayList<Uri> all=intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);if(all!=null)uris.addAll(all);}else{Uri uri=intent.getParcelableExtra(Intent.EXTRA_STREAM);if(uri!=null)uris.add(uri);}if(uris.isEmpty()&&intent.getType()!=null&&intent.getType().startsWith("image/")&&intent.getClipData()!=null){for(int i=0;i<intent.getClipData().getItemCount();i++)if(intent.getClipData().getItemAt(i).getUri()!=null)uris.add(intent.getClipData().getItemAt(i).getUri());}if(uris.size()>3)throw new Exception("一次最多附上 3 张图片");if(!uris.isEmpty()){try(RecordStore store=new RecordStore(this)){store.putDraft(id,input.getText().toString(),source,images);}Importer.add(this,id,uris);}}catch(Exception error){Toast.makeText(this,Sync.safe(error),Toast.LENGTH_LONG).show();}}
    @Override public void imported(String draftId,String error){if(!id.equals(draftId))return;refresh();if(!error.isEmpty())Toast.makeText(this,error,Toast.LENGTH_LONG).show();}
    private void save(){if(saving||Importer.busy(id))return;refresh();String text=input.getText().toString().trim();if(text.isEmpty()&&images.length()==0){input.setError("写一句话，或分享一张图片");return;}if(text.length()>20000){input.setError("请分成几条登记，每条最多 20000 字");return;}saving=true;refresh();try(RecordStore store=new RecordStore(this)){store.save(id,text,source,new JSONArray(images.toString()));saved=true;getSharedPreferences("quick-draft",0).edit().remove("id").commit();Toast.makeText(this,"已记下",Toast.LENGTH_SHORT).show();Sync.schedule(this);final android.content.Context app=getApplicationContext();NETWORK.execute(()->Sync.run(app));finish();}catch(Exception error){Toast.makeText(this,"尚未保存："+Sync.safe(error),Toast.LENGTH_LONG).show();}finally{saving=false;}}
}
