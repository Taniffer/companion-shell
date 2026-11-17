package org.companion.capture;
import android.app.job.JobParameters;
import android.app.job.JobService;
public final class SyncJobService extends JobService {
    @Override public boolean onStartJob(JobParameters params){new Thread(()->{Sync.run(getApplicationContext());jobFinished(params,false);},"capture-background-sync").start();return true;}
    @Override public boolean onStopJob(JobParameters params){return true;}
}
