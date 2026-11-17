package org.companion.sharetest;
import android.content.*;import android.database.Cursor;import android.database.MatrixCursor;import android.net.Uri;import android.os.ParcelFileDescriptor;import android.provider.OpenableColumns;import android.graphics.*;import java.io.*;
public class ImageProvider extends ContentProvider{
  private File file;
  @Override public boolean onCreate(){try{file=new File(getContext().getCacheDir(),"sample.png");Bitmap b=Bitmap.createBitmap(480,320,Bitmap.Config.ARGB_8888);Canvas c=new Canvas(b);c.drawColor(0xffe8efe4);Paint p=new Paint();p.setColor(0xff24766b);p.setTextSize(30);c.drawText("COMPANION QA IMAGE",30,140,p);c.drawText("Real content:// sharing",30,200,p);try(FileOutputStream out=new FileOutputStream(file)){b.compress(Bitmap.CompressFormat.PNG,100,out);}return true;}catch(Exception e){return false;}}
  @Override public String getType(Uri u){return "image/png";}
  @Override public ParcelFileDescriptor openFile(Uri u,String mode)throws FileNotFoundException{if(!"r".equals(mode))throw new FileNotFoundException("Read only");return ParcelFileDescriptor.open(file,ParcelFileDescriptor.MODE_READ_ONLY);}
  @Override public Cursor query(Uri u,String[] projection,String selection,String[] args,String order){MatrixCursor c=new MatrixCursor(new String[]{OpenableColumns.DISPLAY_NAME,OpenableColumns.SIZE});c.addRow(new Object[]{"sample.png",file.length()});return c;}
  @Override public Uri insert(Uri u,ContentValues v){throw new UnsupportedOperationException();}@Override public int update(Uri u,ContentValues v,String s,String[] a){throw new UnsupportedOperationException();}@Override public int delete(Uri u,String s,String[] a){throw new UnsupportedOperationException();}
}
