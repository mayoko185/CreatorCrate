using System.Runtime.InteropServices;
using OpenLocally;

namespace OpenLocally.Tests;

/// <summary>
/// Coverage for <see cref="FailureReporter"/>'s channel selection: the GUI
/// subsystem has no console, so failures must go to stderr when a console or
/// redirect exists and to a message box only when no standard-error handle is
/// available (normal protocol activation). The decision is exposed through
/// the internal <see cref="FailureReporter.IsStderrAvailable"/> probe so it
/// can be tested without showing UI or writing to real handles.
/// </summary>
public class FailureReporterTests
{
    [Fact]
    public void IsStderrAvailable_ZeroHandle_IsFalse()
    {
        // GetStdHandle returns NULL when the process has no console and no
        // redirected standard handle: the message-box branch must trigger.
        Assert.False(FailureReporter.IsStderrAvailable(IntPtr.Zero));
    }

    [Fact]
    public void IsStderrAvailable_InvalidHandle_IsFalse()
    {
        Assert.False(FailureReporter.IsStderrAvailable(new IntPtr(-1)));
    }

    [Fact]
    public void IsStderrAvailable_NonNullValidHandle_IsTrue()
    {
        Assert.True(FailureReporter.IsStderrAvailable(new IntPtr(7)));
    }
}
