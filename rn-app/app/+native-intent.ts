export async function redirectSystemPath({ path, initial }: { path: string; initial: boolean }) {
  try {
    const url = new URL(path);
    if (url.hostname === 'expo-sharing') {
      // Cold start (e.g. user shares a video INTO NativeOS from
      // another app's share sheet) → land on the videos tab so the
      // `Sharing.useIncomingShare()` consumer in `videos.tsx` can
      // pick the payload up.
      //
      // In-app `shareAsync` (e.g. sharing a backup .zip from
      // `settings.tsx`) doesn't restart the activity — but on some
      // emulators (notably MuMu) the OS can still dispatch the zip
      // back into our own `expo-sharing://` deep link, which used
      // to blow away the just-shown "备份成功" alert and shove the
      // user onto the videos tab. Returning `null` tells expo-router
      // to leave the current route alone, and `videos.tsx` will
      // quietly drop the non-video payload on the floor.
      if (!initial) {
        return null;
      }
      return '/(tabs)/videos?shared=1';
    }
    return path;
  } catch {
    return path;
  }
}
