param(
  [string]$EndpointName = 'MAIN',
  [int]$DurationSeconds = 10,
  [int]$IntervalMs = 100,
  [string]$OutputPath = "$env:TEMP\webrc-audio-benchmark\main-endpoint-diagnostic.json"
)

$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

public enum AudioDataFlow { Render = 0, Capture = 1, All = 2 }

[StructLayout(LayoutKind.Sequential)]
public struct AudioPropertyKey { public Guid fmtid; public int pid; }

[StructLayout(LayoutKind.Explicit)]
public struct AudioPropVariant { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr pointer; }

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E"), ClassInterface(ClassInterfaceType.None)]
public class AudioMMDeviceEnumerator { }

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioMMDeviceEnumerator {
  [PreserveSig] int EnumAudioEndpoints(AudioDataFlow flow, uint stateMask, out IAudioMMDeviceCollection devices);
  [PreserveSig] int GetDefaultAudioEndpoint(AudioDataFlow flow, int role, out IAudioMMDevice device);
  [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IAudioMMDevice device);
  [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr callback);
  [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr callback);
}

[ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioMMDeviceCollection {
  [PreserveSig] int GetCount(out uint count);
  [PreserveSig] int Item(uint index, out IAudioMMDevice device);
}

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioMMDevice {
  [PreserveSig] int Activate(ref Guid iid, uint clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object instance);
  [PreserveSig] int OpenPropertyStore(uint mode, out IAudioPropertyStore store);
  [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
  [PreserveSig] int GetState(out uint state);
}

[ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioPropertyStore {
  [PreserveSig] int GetCount(out uint count);
  [PreserveSig] int GetAt(uint index, out AudioPropertyKey key);
  [PreserveSig] int GetValue(ref AudioPropertyKey key, out AudioPropVariant value);
  [PreserveSig] int SetValue(ref AudioPropertyKey key, ref AudioPropVariant value);
  [PreserveSig] int Commit();
}

[ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioEndpointVolume {
  [PreserveSig] int RegisterControlChangeNotify(IntPtr notify);
  [PreserveSig] int UnregisterControlChangeNotify(IntPtr notify);
  [PreserveSig] int GetChannelCount(out uint count);
  [PreserveSig] int SetMasterVolumeLevel(float level, IntPtr context);
  [PreserveSig] int SetMasterVolumeLevelScalar(float level, IntPtr context);
  [PreserveSig] int GetMasterVolumeLevel(out float level);
  [PreserveSig] int GetMasterVolumeLevelScalar(out float level);
  [PreserveSig] int SetChannelVolumeLevel(uint channel, float level, IntPtr context);
  [PreserveSig] int SetChannelVolumeLevelScalar(uint channel, float level, IntPtr context);
  [PreserveSig] int GetChannelVolumeLevel(uint channel, out float level);
  [PreserveSig] int GetChannelVolumeLevelScalar(uint channel, out float level);
  [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, IntPtr context);
  [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
  [PreserveSig] int GetVolumeStepInfo(out uint step, out uint stepCount);
  [PreserveSig] int VolumeStepUp(IntPtr context);
  [PreserveSig] int VolumeStepDown(IntPtr context);
  [PreserveSig] int QueryHardwareSupport(out uint supportMask);
  [PreserveSig] int GetVolumeRange(out float minDb, out float maxDb, out float incrementDb);
}

[ComImport, Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioMeterInformation {
  [PreserveSig] int GetPeakValue(out float peak);
  [PreserveSig] int GetMeteringChannelCount(out uint count);
  [PreserveSig] int GetChannelsPeakValues(uint count, [Out, MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 0)] float[] peaks);
}

[ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioSessionManager2 {
  [PreserveSig] int GetAudioSessionControl(ref Guid sessionGuid, uint flags, out IAudioSessionControl control);
  [PreserveSig] int GetSimpleAudioVolume(ref Guid sessionGuid, uint flags, out ISimpleAudioVolume volume);
  [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator enumerator);
  [PreserveSig] int RegisterSessionNotification(IntPtr notification);
  [PreserveSig] int UnregisterSessionNotification(IntPtr notification);
  [PreserveSig] int RegisterDuckNotification([MarshalAs(UnmanagedType.LPWStr)] string sessionId, IntPtr notification);
  [PreserveSig] int UnregisterDuckNotification(IntPtr notification);
}

[ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioSessionEnumerator {
  [PreserveSig] int GetCount(out int count);
  [PreserveSig] int GetSession(int index, out IAudioSessionControl control);
}

[ComImport, Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioSessionControl {
  [PreserveSig] int GetState(out int state);
  [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
  [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr context);
  [PreserveSig] int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
  [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string path, IntPtr context);
  [PreserveSig] int GetGroupingParam(out Guid grouping);
  [PreserveSig] int SetGroupingParam(ref Guid grouping, IntPtr context);
  [PreserveSig] int RegisterAudioSessionNotification(IntPtr notification);
  [PreserveSig] int UnregisterAudioSessionNotification(IntPtr notification);
}

[ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioSessionControl2 {
  [PreserveSig] int GetState(out int state);
  [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
  [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr context);
  [PreserveSig] int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
  [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string path, IntPtr context);
  [PreserveSig] int GetGroupingParam(out Guid grouping);
  [PreserveSig] int SetGroupingParam(ref Guid grouping, IntPtr context);
  [PreserveSig] int RegisterAudioSessionNotification(IntPtr notification);
  [PreserveSig] int UnregisterAudioSessionNotification(IntPtr notification);
  [PreserveSig] int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string identifier);
  [PreserveSig] int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string identifier);
  [PreserveSig] int GetProcessId(out uint processId);
  [PreserveSig] int IsSystemSoundsSession();
  [PreserveSig] int SetDuckingPreference([MarshalAs(UnmanagedType.Bool)] bool optOut);
}

[ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface ISimpleAudioVolume {
  [PreserveSig] int SetMasterVolume(float level, IntPtr context);
  [PreserveSig] int GetMasterVolume(out float level);
  [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, IntPtr context);
  [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
}

public static class ReadOnlyAudioEndpointProbe {
  private const uint ActiveDeviceState = 1;
  private const uint ClsCtxAll = 23;
  private static readonly Guid FriendlyNameFormat = new Guid("A45C254E-DF1C-4EFD-8020-67D146A850E0");

  [DllImport("ole32.dll")]
  private static extern int PropVariantClear(ref AudioPropVariant value);

  public static List<Dictionary<string, object>> ReadDuring(string namePart, int durationMs, int intervalMs) {
    IAudioMMDeviceEnumerator enumerator = (IAudioMMDeviceEnumerator)new AudioMMDeviceEnumerator();
    IAudioMMDeviceCollection devices;
    Marshal.ThrowExceptionForHR(enumerator.EnumAudioEndpoints(AudioDataFlow.Render, ActiveDeviceState, out devices));
    uint deviceCount;
    Marshal.ThrowExceptionForHR(devices.GetCount(out deviceCount));
    var matches = new List<IAudioMMDevice>();
    var names = new List<string>();
    var ids = new List<string>();
    for (uint i = 0; i < deviceCount; i++) {
      IAudioMMDevice device;
      Marshal.ThrowExceptionForHR(devices.Item(i, out device));
      string friendlyName = GetFriendlyName(device);
      string id;
      Marshal.ThrowExceptionForHR(device.GetId(out id));
      if (friendlyName.IndexOf(namePart, StringComparison.OrdinalIgnoreCase) >= 0
          && friendlyName.IndexOf("RC-505mk2", StringComparison.OrdinalIgnoreCase) >= 0) {
        matches.Add(device);
        names.Add(friendlyName);
        ids.Add(id);
      }
    }
    if (matches.Count != 1) throw new InvalidOperationException("Expected one active RC-505mkII render endpoint matching '" + namePart + "'; found " + matches.Count + ". Endpoints: " + String.Join(" | ", names));

    Guid volumeIid = typeof(IAudioEndpointVolume).GUID;
    object volumeObject;
    Marshal.ThrowExceptionForHR(matches[0].Activate(ref volumeIid, ClsCtxAll, IntPtr.Zero, out volumeObject));
    IAudioEndpointVolume endpointVolume = (IAudioEndpointVolume)volumeObject;
    Guid meterIid = typeof(IAudioMeterInformation).GUID;
    object meterObject;
    Marshal.ThrowExceptionForHR(matches[0].Activate(ref meterIid, ClsCtxAll, IntPtr.Zero, out meterObject));
    IAudioMeterInformation meter = (IAudioMeterInformation)meterObject;
    Guid sessionIid = typeof(IAudioSessionManager2).GUID;
    object sessionObject;
    Marshal.ThrowExceptionForHR(matches[0].Activate(ref sessionIid, ClsCtxAll, IntPtr.Zero, out sessionObject));
    IAudioSessionManager2 sessionManager = (IAudioSessionManager2)sessionObject;

    var snapshots = new List<Dictionary<string, object>>();
    var timer = System.Diagnostics.Stopwatch.StartNew();
    do {
      float endpointScalar;
      bool endpointMute;
      float peak;
      int volumeResult = endpointVolume.GetMasterVolumeLevelScalar(out endpointScalar);
      int muteResult = endpointVolume.GetMute(out endpointMute);
      int meterResult = meter.GetPeakValue(out peak);
      var sessions = ReadSessions(sessionManager);
      var entry = new Dictionary<string, object>();
      entry["sampledAt"] = DateTime.UtcNow.ToString("o");
      entry["endpointLabel"] = names[0];
      entry["endpointId"] = ids[0];
      entry["endpointVolumeScalar"] = volumeResult < 0 ? (object)null : endpointScalar;
      entry["endpointVolumeHResult"] = volumeResult;
      entry["endpointMuted"] = muteResult < 0 ? (object)null : endpointMute;
      entry["endpointMuteHResult"] = muteResult;
      entry["endpointPeak"] = meterResult < 0 ? (object)null : peak;
      entry["endpointPeakHResult"] = meterResult;
      entry["sessions"] = sessions;
      snapshots.Add(entry);
      Thread.Sleep(Math.Max(25, intervalMs));
    } while (timer.ElapsedMilliseconds < durationMs);
    return snapshots;
  }

  private static List<Dictionary<string, object>> ReadSessions(IAudioSessionManager2 manager) {
    var result = new List<Dictionary<string, object>>();
    IAudioSessionEnumerator enumerator;
    int hr = manager.GetSessionEnumerator(out enumerator);
    if (hr < 0) return result;
    int count;
    if (enumerator.GetCount(out count) < 0) return result;
    for (int i = 0; i < count; i++) {
      IAudioSessionControl control;
      if (enumerator.GetSession(i, out control) < 0) continue;
      try {
        IAudioSessionControl2 control2 = (IAudioSessionControl2)control;
        string displayName;
        uint processId;
        int state;
        control2.GetDisplayName(out displayName);
        control2.GetProcessId(out processId);
        control2.GetState(out state);
        float volume;
        bool muted;
        ISimpleAudioVolume simpleVolume = (ISimpleAudioVolume)control;
        int volumeResult = simpleVolume.GetMasterVolume(out volume);
        int muteResult = simpleVolume.GetMute(out muted);
        var session = new Dictionary<string, object>();
        session["displayName"] = displayName;
        session["processId"] = processId;
        try { session["processName"] = Process.GetProcessById((int)processId).ProcessName; }
        catch { session["processName"] = null; }
        session["state"] = state;
        session["volumeScalar"] = volumeResult < 0 ? (object)null : volume;
        session["muted"] = muteResult < 0 ? (object)null : muted;
        result.Add(session);
      } catch { }
    }
    return result;
  }

  private static string GetFriendlyName(IAudioMMDevice device) {
    IAudioPropertyStore store;
    Marshal.ThrowExceptionForHR(device.OpenPropertyStore(0, out store));
    AudioPropertyKey key = new AudioPropertyKey();
    key.fmtid = FriendlyNameFormat;
    key.pid = 14;
    AudioPropVariant value;
    Marshal.ThrowExceptionForHR(store.GetValue(ref key, out value));
    try { return value.vt == 31 ? Marshal.PtrToStringUni(value.pointer) : ""; }
    finally { PropVariantClear(ref value); }
  }
}
'@

Add-Type -TypeDefinition $source
$snapshots = [ReadOnlyAudioEndpointProbe]::ReadDuring($EndpointName, $DurationSeconds * 1000, $IntervalMs)
$parent = Split-Path -Parent $OutputPath
New-Item -ItemType Directory -Force -Path $parent | Out-Null
$snapshots | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath $OutputPath -Encoding utf8
$allPeaks = @($snapshots | Where-Object { $null -ne $_.endpointPeak } | ForEach-Object { [double]$_.endpointPeak })
$peakMax = if ($allPeaks.Count) { ($allPeaks | Measure-Object -Maximum).Maximum } else { $null }
$sessionRows = @($snapshots | ForEach-Object { $_.sessions } | ForEach-Object {
  [pscustomobject]@{ processId=$_.processId; processName=$_.processName; displayName=$_.displayName; volumeScalar=$_.volumeScalar; muted=$_.muted }
} | Sort-Object processId,processName,displayName,volumeScalar,muted -Unique)
[pscustomobject]@{
  outputPath = $OutputPath
  samples = $snapshots.Count
  endpoint = $snapshots[0].endpointLabel
  endpointVolumeScalar = $snapshots[0].endpointVolumeScalar
  endpointMuted = $snapshots[0].endpointMuted
  maximumEndpointPeak = $peakMax
  distinctSessions = $sessionRows
} | ConvertTo-Json -Depth 7
