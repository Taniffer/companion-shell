package org.companion.capture;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

public final class Connection {
    public static final class HttpError extends Exception { public final int status;HttpError(int status,String message){super(message);this.status=status;} }
    private static final String ALIAS="companion-capture-pairing";
    private static SecretKey key() throws Exception {
        KeyStore store=KeyStore.getInstance("AndroidKeyStore");store.load(null);
        if(!store.containsAlias(ALIAS)){
            KeyGenerator gen=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore");
            gen.init(new KeyGenParameterSpec.Builder(ALIAS,KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());gen.generateKey();
        }
        return (SecretKey)store.getKey(ALIAS,null);
    }
    public static void save(Context c,JSONObject value) throws Exception {
        Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.ENCRYPT_MODE,key());
        String iv=Base64.encodeToString(cipher.getIV(),Base64.NO_WRAP);
        String data=Base64.encodeToString(cipher.doFinal(value.toString().getBytes(StandardCharsets.UTF_8)),Base64.NO_WRAP);
        if(!c.getSharedPreferences("connection",0).edit().putString("iv",iv).putString("data",data).commit())throw new Exception("无法保存配对信息");
    }
    public static JSONObject load(Context c) throws Exception {
        SharedPreferences p=c.getSharedPreferences("connection",0);if(!p.contains("data"))return null;
        Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.DECRYPT_MODE,key(),new GCMParameterSpec(128,Base64.decode(p.getString("iv",""),Base64.NO_WRAP)));
        return new JSONObject(new String(cipher.doFinal(Base64.decode(p.getString("data",""),Base64.NO_WRAP)),StandardCharsets.UTF_8));
    }
    private static byte[] fromHex(String value) throws Exception {
        if(!value.matches("[0-9a-fA-F]{64}"))throw new Exception("配对信息中的电脑指纹无效");
        byte[] data=new byte[32];for(int i=0;i<32;i++)data[i]=(byte)Integer.parseInt(value.substring(i*2,i*2+2),16);return data;
    }
    public static JSONObject post(JSONObject config,String path,JSONObject body) throws Exception {
        URL base=new URL(config.getString("url"));
        if(!base.getProtocol().equals("https")||base.getUserInfo()!=null||!base.getPath().isEmpty())throw new Exception("电脑地址必须是有效的 HTTPS 地址");
        final byte[] expected=fromHex(config.getString("pin"));
        X509TrustManager trust=new X509TrustManager(){
            public X509Certificate[] getAcceptedIssuers(){return new X509Certificate[0];}
            public void checkClientTrusted(X509Certificate[] c,String a)throws CertificateException{throw new CertificateException("Not a client connection");}
            public void checkServerTrusted(X509Certificate[] chain,String auth)throws CertificateException{
                try{if(chain.length<1)throw new CertificateException("Missing certificate");chain[0].checkValidity();if(!MessageDigest.isEqual(expected,MessageDigest.getInstance("SHA-256").digest(chain[0].getEncoded())))throw new CertificateException("Computer fingerprint changed");}
                catch(CertificateException e){throw e;}catch(Exception e){throw new CertificateException(e);}
            }
        };
        SSLContext tls=SSLContext.getInstance("TLS");tls.init(null,new TrustManager[]{trust},new SecureRandom());
        HttpsURLConnection connection=(HttpsURLConnection)new URL(config.getString("url")+path).openConnection();
        connection.setSSLSocketFactory(tls.getSocketFactory());
        connection.setHostnameVerifier((hostname,session)->{try{return MessageDigest.isEqual(expected,MessageDigest.getInstance("SHA-256").digest(session.getPeerCertificates()[0].getEncoded()));}catch(Exception e){return false;}});
        connection.setConnectTimeout(12000);connection.setReadTimeout(20000);connection.setInstanceFollowRedirects(false);connection.setRequestMethod("POST");connection.setRequestProperty("Content-Type","application/json; charset=utf-8");
        if(config.has("token"))connection.setRequestProperty("Authorization","Bearer "+config.getString("token"));
        connection.setDoOutput(true);byte[] payload=body.toString().getBytes(StandardCharsets.UTF_8);connection.setFixedLengthStreamingMode(payload.length);
        try {
            connection.getOutputStream().write(payload);
            int status=connection.getResponseCode();
            InputStream input=status>=200&&status<300?connection.getInputStream():connection.getErrorStream();
            String response="";
            if(input!=null)try(InputStream in=input;ByteArrayOutputStream out=new ByteArrayOutputStream()){byte[] b=new byte[4096];int n;while((n=in.read(b))!=-1){if(out.size()+n>1024*1024)throw new Exception("电脑返回内容过大");out.write(b,0,n);}response=out.toString("UTF-8");}
            JSONObject result=response.isEmpty()?new JSONObject():new JSONObject(response);
            if(status<200||status>=300)throw new HttpError(status,result.optString("error","连接未完成（"+status+"）"));
            return result;
        } finally { connection.disconnect(); }
    }
}
