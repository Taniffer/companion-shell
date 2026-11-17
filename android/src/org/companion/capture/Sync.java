package org.companion.capture;

import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.Context;
import android.util.Base64;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.io.FileInputStream;
import java.io.ByteArrayOutputStream;
import java.util.concurrent.atomic.AtomicBoolean;

public final class Sync {
    private static final AtomicBoolean busy=new AtomicBoolean(false);
    public static String run(Context context) {
        if(!busy.compareAndSet(false,true))return "正在同步";
        try(RecordStore store=new RecordStore(context)){
            JSONObject config=Connection.load(context);if(config==null)return "已留在手机，连接电脑后同步";
            int count=0,needsAttention=0;
            for(JSONObject record:store.list(true,100)){
                boolean sending=false;
                try{
                    JSONArray files=new JSONArray();JSONArray attachments=record.optJSONArray("attachments");
                    if(attachments!=null)for(int i=0;i<attachments.length();i++){
                        JSONObject metadata=attachments.getJSONObject(i);File file=new File(context.getFilesDir(),metadata.getString("localPath"));
                        if(!file.getCanonicalPath().startsWith(context.getFilesDir().getCanonicalPath()+File.separator))throw new Exception("本地附件路径无效");
                        if(file.length()>8L*1024*1024)throw new Exception("单张图片超过 8 MB");
                        try(FileInputStream in=new FileInputStream(file);ByteArrayOutputStream out=new ByteArrayOutputStream()){byte[] b=new byte[8192];int n;while((n=in.read(b))!=-1)out.write(b,0,n);JSONObject upload=new JSONObject();upload.put("name",metadata.optString("name","image"));upload.put("mime",metadata.getString("mime"));upload.put("base64",Base64.encodeToString(out.toByteArray(),Base64.NO_WRAP));files.put(upload);}
                    }
                    JSONObject payload=new JSONObject(record.toString());payload.remove("synced");payload.remove("error");payload.put("attachments",files);
                    sending=true;Connection.post(config,"/mobile/captures",payload);store.synced(record.getString("id"));count++;
                }catch(Exception e){boolean permanent=!sending||(e instanceof Connection.HttpError&&((Connection.HttpError)e).status>=400&&((Connection.HttpError)e).status<500&&((Connection.HttpError)e).status!=401&&((Connection.HttpError)e).status!=429);if(permanent){store.pauseRecord(record.optString("id"),"需要处理："+safe(e));needsAttention++;continue;}store.error(record.optString("id"),"未同步："+safe(e));return count>0?"已同步 "+count+" 条，其余留在手机":safe(e)+"；记录仍在手机";}
            }
            needsAttention=store.pausedCount();return needsAttention>0?"已同步 "+count+" 条；有 "+needsAttention+" 条仍留手机，请到记录页查看":count>0?"已同步 "+count+" 条到电脑":"记录已与电脑同步";
        }catch(Exception e){return safe(e)+"；记录仍在手机";}finally{busy.set(false);}
    }
    public static String safe(Exception e){String value=e.getMessage();if(value==null)return "暂时无法连接电脑";if(value.contains("fingerprint")||value.contains("certificate")||value.contains("SSL"))return "电脑指纹验证失败，请重新核对配对";if(value.contains("connect")||value.contains("timeout")||value.contains("Unable to resolve"))return "暂时无法连接电脑";return value.length()>180?"同步暂未完成":value;}
    public static void schedule(Context context){try{JobScheduler scheduler=(JobScheduler)context.getSystemService(Context.JOB_SCHEDULER_SERVICE);scheduler.schedule(new JobInfo.Builder(2107,new ComponentName(context,SyncJobService.class)).setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).setPeriodic(15*60*1000L).setPersisted(true).build());}catch(Exception ignored){}}
}
