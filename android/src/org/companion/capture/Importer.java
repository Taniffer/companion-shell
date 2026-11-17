package org.companion.capture;
import android.content.Context;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;

public final class Importer {
    public interface Listener{void imported(String draftId,String error);}
    private static WeakReference<Listener> listener=new WeakReference<>(null);
    private static final Set<String> active=ConcurrentHashMap.newKeySet();
    private static final java.util.concurrent.ExecutorService IO=Executors.newSingleThreadExecutor();
    public static void listen(Listener value){listener=new WeakReference<>(value);}
    public static void detach(Listener value){if(listener.get()==value)listener=new WeakReference<>(null);}
    public static boolean busy(String id){return active.contains(id);}
    public static void add(Context context,String id,ArrayList<Uri> images){
        final Context app=context.getApplicationContext();if(!active.add(id))return;
        IO.execute(()->{String error="";JSONArray imported=new JSONArray();
            try(RecordStore store=new RecordStore(app)){
                JSONObject draft=store.draft(id);JSONArray existing=draft==null?new JSONArray():draft.optJSONArray("attachments");if(existing==null)existing=new JSONArray();
                if(existing.length()+images.size()>3)throw new Exception("一次最多登记 3 张图片");
                long total=0;for(int i=0;i<existing.length();i++)total+=new File(app.getFilesDir(),existing.getJSONObject(i).getString("localPath")).length();
                for(Uri uri:images){
                    if(uri==null||!"content".equals(uri.getScheme()))throw new Exception("图片来源无效");
                    String mime=app.getContentResolver().getType(uri);
                    if(!"image/png".equals(mime)&&!"image/jpeg".equals(mime)&&!"image/jpg".equals(mime)&&!"image/gif".equals(mime)&&!"image/webp".equals(mime))throw new Exception("请用 PNG、JPEG、GIF 或 WebP；其他图片可截图后登记");
                    File directory=new File(app.getFilesDir(),"images");directory.mkdirs();String filename=UUID.randomUUID()+".image";File file=new File(directory,filename);long size=0;
                    try(InputStream in=app.getContentResolver().openInputStream(uri);FileOutputStream out=new FileOutputStream(file)){if(in==null)throw new Exception("无法读取这张图片");byte[] bytes=new byte[8192];int n;while((n=in.read(bytes))!=-1){size+=n;if(size>8L*1024*1024||total+size>16L*1024*1024)throw new Exception("单张图片最多 8 MB，一次最多 16 MB");out.write(bytes,0,n);}}catch(Exception e){file.delete();throw e;}
                    total+=size;JSONObject item=new JSONObject();item.put("localPath","images/"+filename);item.put("name","image");item.put("mime",mime.equals("image/jpg")?"image/jpeg":mime);imported.put(item);
                }
            }catch(Exception e){error=Sync.safe(e);}
            try(RecordStore store=new RecordStore(app)){store.mergeImages(id,imported);}catch(Exception e){error="图片还未完整导入，请重新选择";}
            active.remove(id);final String result=error;new Handler(Looper.getMainLooper()).post(()->{Listener value=listener.get();if(value!=null)value.imported(id,result);});
        });
    }
}
