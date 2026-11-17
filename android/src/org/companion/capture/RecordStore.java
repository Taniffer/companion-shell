package org.companion.capture;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.UUID;

public final class RecordStore extends SQLiteOpenHelper {
    public RecordStore(Context context) { super(context, "capture.db", null, 2); }
    @Override public void onCreate(SQLiteDatabase db) { db.execSQL("CREATE TABLE records (id TEXT PRIMARY KEY, body TEXT NOT NULL, created INTEGER NOT NULL, synced INTEGER NOT NULL DEFAULT 0, paused INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '')");db.execSQL("CREATE TABLE drafts (id TEXT PRIMARY KEY,body TEXT NOT NULL,updated INTEGER NOT NULL)"); }
    @Override public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) { if(oldVersion<2){db.execSQL("ALTER TABLE records ADD COLUMN paused INTEGER NOT NULL DEFAULT 0");db.execSQL("CREATE TABLE IF NOT EXISTS drafts (id TEXT PRIMARY KEY,body TEXT NOT NULL,updated INTEGER NOT NULL)");} }
    public synchronized String save(String id, String text, String source, JSONArray attachments) throws Exception {
        JSONObject body = new JSONObject();
        body.put("id", id); body.put("text", text); body.put("source", source); body.put("createdAt", System.currentTimeMillis()); body.put("attachments", attachments);
        ContentValues values = new ContentValues(); values.put("id", id); values.put("body", body.toString()); values.put("created", System.currentTimeMillis());
        SQLiteDatabase db=getWritableDatabase();db.beginTransaction();try{long inserted=db.insertWithOnConflict("records",null,values,SQLiteDatabase.CONFLICT_IGNORE);if(inserted==-1){try(Cursor c=db.query("records",new String[]{"body"},"id=?",new String[]{id},null,null,null)){if(!c.moveToFirst())throw new Exception("保存尚未完成");JSONObject prior=new JSONObject(c.getString(0));if(!prior.optString("text").equals(text)||!prior.optString("source").equals(source)||!prior.getJSONArray("attachments").toString().equals(attachments.toString()))throw new Exception("这条草稿已登记，请新建另一条记录");}}db.delete("drafts","id=?",new String[]{id});db.setTransactionSuccessful();return id;}finally{db.endTransaction();}
    }
    public synchronized ArrayList<JSONObject> list(boolean pendingOnly, int limit) throws Exception {
        ArrayList<JSONObject> result = new ArrayList<>();
        try (Cursor cursor = getReadableDatabase().query("records", null, pendingOnly?"synced=0 AND paused=0":null, null, null, null, pendingOnly?"created ASC":"created DESC", String.valueOf(limit))) {
            while(cursor.moveToNext()) {
                JSONObject value = new JSONObject(cursor.getString(cursor.getColumnIndexOrThrow("body")));
                value.put("synced",cursor.getInt(cursor.getColumnIndexOrThrow("synced"))==1);
                value.put("error",cursor.getString(cursor.getColumnIndexOrThrow("error"))); result.add(value);
                value.put("paused",cursor.getInt(cursor.getColumnIndexOrThrow("paused"))==1);
            }
        } return result;
    }
    public synchronized int pendingCount() {
        try(Cursor cursor=getReadableDatabase().rawQuery("SELECT count(*) FROM records WHERE synced=0",null)){cursor.moveToFirst();return cursor.getInt(0);}
    }
    public synchronized int pausedCount(){try(Cursor c=getReadableDatabase().rawQuery("SELECT count(*) FROM records WHERE synced=0 AND paused=1",null)){c.moveToFirst();return c.getInt(0);}}
    public synchronized boolean saved(String id){try(Cursor c=getReadableDatabase().query("records",new String[]{"id"},"id=?",new String[]{id},null,null,null)){return c.moveToFirst();}}
    public synchronized void synced(String id) { ContentValues v=new ContentValues();v.put("synced",1);v.put("error","");getWritableDatabase().update("records",v,"id=?",new String[]{id}); }
    public synchronized void error(String id,String text) { ContentValues v=new ContentValues();v.put("error",text);getWritableDatabase().update("records",v,"id=?",new String[]{id}); }
    public synchronized void pauseRecord(String id,String message){ContentValues v=new ContentValues();v.put("paused",1);v.put("error",message);getWritableDatabase().update("records",v,"id=?",new String[]{id});}
    public synchronized void retry(String id){ContentValues v=new ContentValues();v.put("paused",0);v.put("error","");getWritableDatabase().update("records",v,"id=?",new String[]{id});}
    public synchronized void putDraft(String id,String text,String source,JSONArray images)throws Exception{if(saved(id))return;SQLiteDatabase db=getWritableDatabase();db.beginTransaction();try{JSONObject prior=draft(id);JSONArray merged=prior==null?new JSONArray():prior.optJSONArray("attachments");if(merged==null)merged=new JSONArray();java.util.HashSet<String> seen=new java.util.HashSet<>();for(int i=0;i<merged.length();i++)seen.add(merged.getJSONObject(i).getString("localPath"));for(int i=0;i<images.length();i++){JSONObject image=images.getJSONObject(i);if(seen.add(image.getString("localPath")))merged.put(image);}JSONObject value=new JSONObject();value.put("id",id);value.put("text",text);value.put("source",source);value.put("attachments",merged);ContentValues v=new ContentValues();v.put("id",id);v.put("body",value.toString());v.put("updated",System.currentTimeMillis());db.insertWithOnConflict("drafts",null,v,SQLiteDatabase.CONFLICT_REPLACE);db.setTransactionSuccessful();}finally{db.endTransaction();}}
    public synchronized void clearDraftImages(String id)throws Exception{JSONObject value=draft(id);if(value==null)return;value.put("attachments",new JSONArray());ContentValues v=new ContentValues();v.put("body",value.toString());getWritableDatabase().update("drafts",v,"id=?",new String[]{id});}
    public synchronized JSONObject draft(String id)throws Exception{try(Cursor c=getReadableDatabase().query("drafts",new String[]{"body"},"id=?",new String[]{id},null,null,null)){return c.moveToFirst()?new JSONObject(c.getString(0)):null;}}
    public synchronized ArrayList<JSONObject> drafts()throws Exception{ArrayList<JSONObject> values=new ArrayList<>();try(Cursor c=getReadableDatabase().query("drafts",new String[]{"body"},null,null,null,null,"updated DESC","30")){while(c.moveToNext())values.add(new JSONObject(c.getString(0)));}return values;}
    public synchronized void deleteDraft(String id){getWritableDatabase().delete("drafts","id=?",new String[]{id});}
    public synchronized void deleteDraftIfEmpty(String id)throws Exception{SQLiteDatabase db=getWritableDatabase();db.beginTransaction();try{JSONObject value=draft(id);if(value!=null){value.put("text","");if(value.optJSONArray("attachments")==null||value.optJSONArray("attachments").length()==0)db.delete("drafts","id=?",new String[]{id});else{ContentValues v=new ContentValues();v.put("body",value.toString());db.update("drafts",v,"id=?",new String[]{id});}}db.setTransactionSuccessful();}finally{db.endTransaction();}}
    public synchronized void mergeImages(String id,JSONArray images)throws Exception{SQLiteDatabase db=getWritableDatabase();db.beginTransaction();try{JSONObject value=draft(id);if(value==null)throw new Exception("草稿不可用，请重新选择图片");JSONArray current=value.optJSONArray("attachments");if(current==null)current=new JSONArray();for(int i=0;i<images.length();i++)current.put(images.getJSONObject(i));putDraft(id,value.optString("text"),value.optString("source","android"),current);db.setTransactionSuccessful();}finally{db.endTransaction();}}
}
