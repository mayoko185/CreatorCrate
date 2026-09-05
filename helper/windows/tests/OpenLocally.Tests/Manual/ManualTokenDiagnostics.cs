using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace OpenLocally.Tests.Manual
{
    /// <summary>Read-only normalized Windows token diagnostics for the Manual wrapper and VSTest testhost.</summary>
    public sealed class ManualTokenDiagnostics
    {
        private const uint TokenQuery = 0x0008;
        private const int TokenElevation = 20;
        private const int TokenElevationType = 18;
        private const int TokenIntegrityLevel = 25;
        private const int TokenIsAppContainer = 29;

        private const int SecurityMandatoryUntrustedRid = 0x0000;
        private const int SecurityMandatoryLowRid = 0x1000;
        private const int SecurityMandatoryMediumRid = 0x2000;
        private const int SecurityMandatoryMediumPlusRid = 0x2100;
        private const int SecurityMandatoryHighRid = 0x3000;
        private const int SecurityMandatorySystemRid = 0x4000;
        private const int SecurityMandatoryProtectedProcessRid = 0x5000;

        public ManualTokenDiagnostics(
            int processId,
            bool? isElevated,
            string elevationType,
            string integrityLevel,
            bool? isAppContainer,
            string inspectionStatus)
        {
            ProcessId = processId;
            IsElevated = isElevated;
            ElevationType = elevationType;
            IntegrityLevel = integrityLevel;
            IsAppContainer = isAppContainer;
            InspectionStatus = inspectionStatus;
        }

        public int ProcessId { get; private set; }
        public bool? IsElevated { get; private set; }
        public string ElevationType { get; private set; }
        public string IntegrityLevel { get; private set; }
        public bool? IsAppContainer { get; private set; }
        public string InspectionStatus { get; private set; }

        public static ManualTokenDiagnostics InspectCurrentProcess()
        {
            using (Process current = Process.GetCurrentProcess())
            {
                return InspectProcess(current);
            }
        }

        public static ManualTokenDiagnostics InspectProcess(Process process)
        {
            if (process == null) throw new ArgumentNullException("process");

            IntPtr tokenHandle;
            if (!OpenProcessToken(process.Handle, TokenQuery, out tokenHandle))
            {
                return FromTokenInformation(
                    process.Id,
                    null,
                    null,
                    null,
                    null,
                    "unavailable/open-process-token/" + Marshal.GetLastWin32Error());
            }

            try
            {
                string elevationFailure;
                string elevationTypeFailure;
                string integrityFailure;
                string appContainerFailure;
                int? elevation = ReadDword(tokenHandle, TokenElevation, out elevationFailure);
                int? elevationType = ReadDword(tokenHandle, TokenElevationType, out elevationTypeFailure);
                int? integrity = ReadIntegrityRid(tokenHandle, out integrityFailure);
                int? appContainer = ReadDword(tokenHandle, TokenIsAppContainer, out appContainerFailure);

                return FromTokenInformation(
                    process.Id,
                    elevation,
                    elevationType,
                    integrity,
                    appContainer,
                    CreateInspectionStatus(elevationFailure, elevationTypeFailure, integrityFailure, appContainerFailure));
            }
            finally
            {
                CloseHandle(tokenHandle);
            }
        }

        public static ManualTokenDiagnostics FromTokenInformation(
            int processId,
            int? elevation,
            int? elevationType,
            int? integrityRid,
            int? isAppContainer,
            string inspectionStatus)
        {
            return new ManualTokenDiagnostics(
                processId,
                NormalizeBoolean(elevation),
                NormalizeElevationType(elevationType),
                NormalizeIntegrityLevel(integrityRid),
                NormalizeBoolean(isAppContainer),
                inspectionStatus ?? "unknown");
        }

        public static string NormalizeElevationType(int? value)
        {
            if (!value.HasValue) return "unknown";

            switch (value.Value)
            {
                case 1: return "default";
                case 2: return "full";
                case 3: return "limited";
                default: return "unknown";
            }
        }

        public static string NormalizeIntegrityLevel(int? rid)
        {
            if (!rid.HasValue) return "unknown";

            switch (rid.Value)
            {
                case SecurityMandatoryUntrustedRid: return "untrusted";
                case SecurityMandatoryLowRid: return "low";
                case SecurityMandatoryMediumRid: return "medium";
                case SecurityMandatoryMediumPlusRid: return "medium_plus";
                case SecurityMandatoryHighRid: return "high";
                case SecurityMandatorySystemRid: return "system";
                case SecurityMandatoryProtectedProcessRid: return "protected";
                default: return "unknown/" + rid.Value;
            }
        }

        private static bool? NormalizeBoolean(int? value)
        {
            if (!value.HasValue) return null;
            if (value.Value == 0) return false;
            if (value.Value == 1) return true;
            return null;
        }

        private static string CreateInspectionStatus(params string[] failures)
        {
            var actual = new List<string>();
            foreach (string failure in failures)
            {
                if (!string.IsNullOrWhiteSpace(failure)) actual.Add(failure);
            }

            return actual.Count == 0 ? "ok" : "partial/" + string.Join(",", actual.ToArray());
        }

        private static int? ReadDword(IntPtr tokenHandle, int informationClass, out string failure)
        {
            int length;
            IntPtr data = ReadTokenInformation(tokenHandle, informationClass, out length, out failure);
            if (data == IntPtr.Zero) return null;

            try
            {
                if (length < sizeof(int))
                {
                    failure = "token-" + informationClass + "/invalid-length";
                    return null;
                }

                return Marshal.ReadInt32(data);
            }
            finally
            {
                Marshal.FreeHGlobal(data);
            }
        }

        private static int? ReadIntegrityRid(IntPtr tokenHandle, out string failure)
        {
            int length;
            IntPtr data = ReadTokenInformation(tokenHandle, TokenIntegrityLevel, out length, out failure);
            if (data == IntPtr.Zero) return null;

            try
            {
                if (length < Marshal.SizeOf(typeof(SidAndAttributes)))
                {
                    failure = "token-" + TokenIntegrityLevel + "/invalid-length";
                    return null;
                }

                var label = (SidAndAttributes)Marshal.PtrToStructure(data, typeof(SidAndAttributes));
                if (label.Sid == IntPtr.Zero)
                {
                    failure = "token-" + TokenIntegrityLevel + "/missing-sid";
                    return null;
                }

                IntPtr count = GetSidSubAuthorityCount(label.Sid);
                if (count == IntPtr.Zero)
                {
                    failure = "token-" + TokenIntegrityLevel + "/missing-rid";
                    return null;
                }

                byte countValue = Marshal.ReadByte(count);
                if (countValue == 0)
                {
                    failure = "token-" + TokenIntegrityLevel + "/missing-rid";
                    return null;
                }

                IntPtr rid = GetSidSubAuthority(label.Sid, (uint)(countValue - 1));
                if (rid == IntPtr.Zero)
                {
                    failure = "token-" + TokenIntegrityLevel + "/missing-rid";
                    return null;
                }

                return Marshal.ReadInt32(rid);
            }
            finally
            {
                Marshal.FreeHGlobal(data);
            }
        }

        private static IntPtr ReadTokenInformation(IntPtr tokenHandle, int informationClass, out int length, out string failure)
        {
            uint requiredLength;
            GetTokenInformation(tokenHandle, informationClass, IntPtr.Zero, 0, out requiredLength);
            int initialError = Marshal.GetLastWin32Error();
            if (requiredLength == 0)
            {
                length = 0;
                failure = "token-" + informationClass + "/query-" + initialError;
                return IntPtr.Zero;
            }

            IntPtr data = Marshal.AllocHGlobal((int)requiredLength);
            if (!GetTokenInformation(tokenHandle, informationClass, data, requiredLength, out requiredLength))
            {
                int error = Marshal.GetLastWin32Error();
                Marshal.FreeHGlobal(data);
                length = 0;
                failure = "token-" + informationClass + "/query-" + error;
                return IntPtr.Zero;
            }

            length = (int)requiredLength;
            failure = null;
            return data;
        }

        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool OpenProcessToken(IntPtr processHandle, uint desiredAccess, out IntPtr tokenHandle);

        [DllImport("advapi32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetTokenInformation(
            IntPtr tokenHandle,
            int tokenInformationClass,
            IntPtr tokenInformation,
            uint tokenInformationLength,
            out uint returnLength);

        [DllImport("advapi32.dll")]
        private static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);

        [DllImport("advapi32.dll")]
        private static extern IntPtr GetSidSubAuthority(IntPtr sid, uint subAuthority);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CloseHandle(IntPtr handle);

        [StructLayout(LayoutKind.Sequential)]
        private struct SidAndAttributes
        {
            public IntPtr Sid;
            public uint Attributes;
        }
    }
}
