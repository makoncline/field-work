"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Terminal,
  Play,
  Loader2,
  Download,
  X,
  Mic,
  MicOff,
  Pause,
  SkipBack,
  SkipForward,
  Rewind,
  FastForward,
} from "lucide-react";
import { usePorcupine } from "@picovoice/porcupine-react";
import { env } from "@/env";

interface VideoDevice {
  deviceId: string;
  label: string;
}

// Option 1: Continuous recording with small timeslices
const RECORDING_TIMESLICE_MS = 1000; // How often ondataavailable fires (Increased to 1s)
const BUFFER_DURATION_MS = 3000; // Keep ~3 seconds of chunks
// --- New constants/refs for long recording + trim approach ---
const MAX_RECORD_DURATION_MS = 60000; // Max 60 seconds recording before auto-processing

// Define preferred mime types - Prioritize WebM (omitting VP9 entries)
const PREFERRED_MIME_TYPES = [
  'video/webm; codecs="vp8, opus"',
  "video/webm; codecs=vp8",
  "video/webm",
  'video/mp4; codecs="avc1.42E01E, mp4a.40.2"',
  "video/mp4; codecs=avc1",
  "video/mp4",
];

// Store individual chunks with timestamps
interface RecordedChunk {
  blob: Blob;
  timestamp: number; // ms since epoch when data became available
}

// Single loop clip generated on demand
interface LoopClip {
  id: string;
  url: string;
  timestamp: number; // time the loop was generated
}

// Type for messages sent to the FFmpeg worker
interface FFmpegWorkerRunMessage {
  type: "run";
  MEMFS: { name: string; data: Uint8Array }[];
  arguments: string[];
}

// Type for messages received from the FFmpeg worker
interface FFmpegWorkerDoneMessage {
  type: "done";
  data: {
    MEMFS: { name: string; data: ArrayBuffer }[];
  };
}

interface FFmpegWorkerMessage {
  type: "ready" | "stdout" | "stderr" | "error" | "abort" | "run" | "exit";
  data?: unknown;
}

// Type for files returned in MEMFS by FFmpeg worker
interface FFmpegOutputFile {
  name: string;
  data: ArrayBuffer | Uint8Array; // Data can be ArrayBuffer or Uint8Array
}

// --- Clip Management ---
const MAX_SAVED_CLIPS = 5; // Keep the last 5 generated clips

// Define a constant for frame duration
const FRAME_DURATION = 1 / 30; // Assuming 30fps

export default function CameraPage() {
  const [devices, setDevices] = useState<VideoDevice[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | undefined>(
    undefined,
  );
  const currentStreamRef = useRef<MediaStream | null>(null); // Ref to hold the stream
  const [error, setError] = useState<string | null>(null);
  const [loopClips, setLoopClips] = useState<LoopClip[]>([]); // State for multiple clips
  const [recorderStatus, setRecorderStatus] = useState<
    "inactive" | "recording" | "paused" | "stopped" | "error"
  >("inactive"); // State to track recorder status
  const [isProcessing, setIsProcessing] = useState(false); // State for FFmpeg processing
  // --- Speech Recognition State ---
  const [isListening, setIsListening] = useState(false);
  const [speechError, setSpeechError] = useState<string | null>(null);
  const [isPorcupineSupported, setIsPorcupineSupported] = useState(true);
  // --- State for selected clip playback ---
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null); // ID of the selected clip
  const [selectedClipTime, setSelectedClipTime] = useState(0);
  const [selectedClipDuration, setSelectedClipDuration] = useState(0);
  const [isSelectedClipPlaying, setIsSelectedClipPlaying] = useState(false); // Track play/pause state
  // --- State for configurable duration ---
  const [targetDurationInputMs, setTargetDurationInputMs] = useState("3000"); // Default to 5s

  const videoRef = useRef<HTMLVideoElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<RecordedChunk[]>([]); // Buffer for timestamped chunks
  const recorderMimeTypeRef = useRef<string | null>(null);
  const currentClipUrlRef = useRef<string | null>(null); // Ref to hold current blob URL for cleanup
  const ffmpegWorkerRef = useRef<Worker | null>(null);
  const currentRecordingStartTimeRef = useRef<number | null>(null);
  const maxRecordingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  // --- Speech Recognition Ref ---
  const speechRecognitionRef = useRef<SpeechRecognition | null>(null);
  const intendedListeningStateRef = useRef(false); // Ref to track if listening is intended
  const lastSpeechErrorRef = useRef<string | null>(null); // Ref to track the last error type
  // --- Ref map for clip video elements ---
  const videoRefs = useRef<Map<string, HTMLVideoElement | null>>(new Map());
  // Ref for debouncing slider video seek
  const seekTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Ref to track if processing was intentionally triggered
  const processIntentRef = useRef(false);

  // --- Porcupine Wake Word Detection ---
  const porcupineHook = usePorcupine();
  const keywordDetection = porcupineHook.keywordDetection;
  // Use type assertions for the values from usePorcupine to resolve TypeScript errors
  const isPorcupineLoaded = porcupineHook.isLoaded;
  const isPorcupineListening = porcupineHook.isListening;
  const porcupineError = porcupineHook.error as string | null;
  const initPorcupine = porcupineHook.init as (
    accessKey: string,
    keyword:
      | { publicPath: string; label: string }
      | Array<{ publicPath: string; label: string }>,
    model: { publicPath: string },
  ) => Promise<void>;
  const startPorcupine = porcupineHook.start as () => Promise<void>;
  const stopPorcupine = porcupineHook.stop as () => Promise<void>;
  const releasePorcupine = porcupineHook.release as () => Promise<void>;

  const getDevices = useCallback(async () => {
    try {
      await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      const allDevices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = allDevices
        .filter((device) => device.kind === "videoinput")
        .map((device, index) => ({
          deviceId: device.deviceId,
          label: device.label || `Camera ${index + 1}`,
        }));
      setDevices(videoDevices);
      if (videoDevices.length > 0 && !selectedDeviceId) {
        setSelectedDeviceId(videoDevices[0]?.deviceId);
      }
    } catch (err) {
      console.error("Error enumerating devices:", err);
      setError(
        `Failed to access camera or list devices. Error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, [selectedDeviceId]);

  useEffect(() => {
    const handleDeviceChange = () => {
      void getDevices();
    };
    void getDevices();
    navigator.mediaDevices.addEventListener("devicechange", handleDeviceChange);
    return () => {
      navigator.mediaDevices.removeEventListener(
        "devicechange",
        handleDeviceChange,
      );
    };
  }, [getDevices]);

  // Function to handle recorder errors
  const handleRecorderError = (event: Event) => {
    console.error("MediaRecorder error:", event);
    let errorMessage = "Unknown MediaRecorder error";
    if (typeof event === "object" && event !== null && "error" in event) {
      const errorEvent = event as { error?: unknown };
      if (errorEvent.error instanceof DOMException) {
        errorMessage = errorEvent.error.message;
      }
    }
    setError(`MediaRecorder error: ${errorMessage}`);
    // Stop stream? Reset state?
    // Cleanup might handle this via useEffect dependency change/unmount
    mediaRecorderRef.current = null; // Ensure ref is null
    setRecorderStatus("error"); // Update status on error
  };

  // Function to handle data buffering (Option 1)
  const handleDataAvailable = (event: BlobEvent) => {
    if (event.data.size > 0) {
      const timestamp = Date.now();
      // console.log(`Buffer: adding chunk size ${event.data.size} at ${timestamp}`);
      recordedChunksRef.current.push({ blob: event.data, timestamp });

      // Trim the buffer to keep only the last BUFFER_DURATION_MS worth of chunks
      const bufferStartTime = timestamp - BUFFER_DURATION_MS;
      let firstValidIndex = -1;
      for (let i = 0; i < recordedChunksRef.current.length; i++) {
        const chunk = recordedChunksRef.current[i];
        // Add check to satisfy linter, although logically chunk should exist here
        if (chunk && chunk.timestamp >= bufferStartTime) {
          firstValidIndex = i;
          break;
        }
      }

      if (firstValidIndex > 0) {
        // console.log(`Buffer: trimming ${firstValidIndex} old chunks.`);
        recordedChunksRef.current =
          recordedChunksRef.current.slice(firstValidIndex);
      } else if (
        firstValidIndex === -1 &&
        recordedChunksRef.current.length > 0
      ) {
        // If all chunks are older than the buffer duration (unlikely with continuous stream), keep the latest one? Or clear?
        // For now, let's assume this doesn't happen frequently with live data.
        // If it did, maybe clear all but the last? recordedChunksRef.current = recordedChunksRef.current.slice(-1);
      }
      // console.log(`Buffer size: ${recordedChunksRef.current.length} chunks`);
    }
  };

  // --- Process Recording Function (defined as regular function) ---
  // const processRecording = useCallback(async () => { // Removed useCallback
  async function processRecording() {
    if (!recorderMimeTypeRef.current) {
      console.error("Mime type missing during processing.");
      setIsProcessing(false);
      return;
    }
    const baseMimeType =
      recorderMimeTypeRef.current.split(";")[0] ?? "video/webm";
    // Combine all chunks collected during the long recording
    const recordedBlob = new Blob(
      recordedChunksRef.current.map((chunk) => chunk.blob),
      { type: baseMimeType },
    );
    const recordingEndTime = Date.now();
    const startTime = currentRecordingStartTimeRef.current ?? recordingEndTime; // Fallback if start time missing
    const recordingDuration = recordingEndTime - startTime;

    console.log(
      `Processing recording. Duration: ${recordingDuration}ms, Size: ${recordedBlob.size}`,
    );

    if (recordedBlob.size === 0) {
      console.error("Recorded blob is empty, cannot process.");
      setError("Recording resulted in empty file.");
      setIsProcessing(false); // Ensure processing stops
      // Restart recording even if processing failed?
      createAndStartRecorder();
      return;
    }

    // --- Get target duration from state ---
    let targetMs = parseInt(targetDurationInputMs, 10);
    // Validate: Use 5000ms (5s) as default/minimum if input is invalid or too small
    if (isNaN(targetMs) || targetMs <= 500) {
      // Min 0.5s?
      console.warn(
        `Invalid target duration input '${targetDurationInputMs}', using default 5000ms`,
      );
      targetMs = 5000;
    }
    const targetDurationSec = targetMs / 1000;
    // ---------------------------------------

    if (recordingDuration < targetMs) {
      // <-- Use parsed targetMs
      console.error(
        `Recording too short (${recordingDuration}ms) for desired clip (${targetMs}ms).`,
      );
      setError(
        `Recording too short for desired ${targetDurationSec}s loop clip.`,
      );
      setIsProcessing(false); // Ensure processing stops
      // Restart recording
      createAndStartRecorder();
      return;
    }

    // Calculate trim parameters
    const offsetMs = recordingDuration - targetMs; // <-- Use parsed targetMs
    const offsetSec = Math.max(0, offsetMs / 1000); // Ensure offset isn't negative
    // targetDurationSec already calculated above

    console.log(
      `Trimming clip from offset: ${offsetSec.toFixed(3)}s for ${targetDurationSec}s duration.`,
    );

    // Start FFmpeg processing
    setIsProcessing(true);
    setError(null);

    try {
      const buffer = await recordedBlob.arrayBuffer();
      const memfsInputs = [
        { name: "input.webm", data: new Uint8Array(buffer) },
      ];
      const ffmpegArgs = [
        "-ss",
        offsetSec.toFixed(3),
        "-i",
        "input.webm",
        "-t",
        targetDurationSec.toString(),
        "-c",
        "copy",
        "-quality",
        "realtime",
        "-cpu-used",
        "8",
        "-y", // Force overwrite
        "output.webm",
      ];

      console.log("Sending trim command to FFmpeg worker:", ffmpegArgs);

      if (!ffmpegWorkerRef.current) {
        console.error("FFmpeg worker not available during processing.");
        setError("FFmpeg worker not available.");
        setIsProcessing(false);
        // Still attempt to restart recording?
        createAndStartRecorder();
        return;
      }

      // Clear buffer for next recording *before* starting FFmpeg
      recordedChunksRef.current = [];
      currentRecordingStartTimeRef.current = null;

      const message: FFmpegWorkerRunMessage = {
        type: "run",
        MEMFS: memfsInputs,
        arguments: ffmpegArgs,
      };
      ffmpegWorkerRef.current.postMessage(message);

      // Note: setIsProcessing(false) is handled in the worker's 'done' or 'error' message handler
    } catch (err) {
      console.error("Error during trimming process:", err);
      setError(
        `Error during clip trimming: ${err instanceof Error ? err.message : String(err)}`,
      );
      setIsProcessing(false);
    }

    // Restart recording immediately after *sending* the processing job
    // This allows the next recording to start while FFmpeg works
    console.log("Restarting recorder after initiating processing...");
    createAndStartRecorder();
  }

  // --- Updated createAndStartRecorder (defined as regular function) ---
  // const createAndStartRecorder = useCallback(() => { // Removed useCallback
  function createAndStartRecorder() {
    if (!currentStreamRef.current || !recorderMimeTypeRef.current) {
      console.error("Cannot create recorder: stream or mimeType missing.");
      setError("Stream or recorder format not available.");
      return;
    }
    // Only proceed if recorder isn't already active
    if (
      mediaRecorderRef.current &&
      mediaRecorderRef.current.state !== "inactive"
    ) {
      console.warn(
        "Recorder already exists and is not inactive. State:",
        mediaRecorderRef.current.state,
      );
      return;
    }

    console.log("Creating and starting recorder instance...");
    try {
      // Ensure mimeType is still valid before creating recorder
      if (!recorderMimeTypeRef.current) {
        console.error(
          "Cannot create recorder: mimeType became null unexpectedly.",
        );
        setError("Recorder format not available.");
        return;
      }
      // Ensure stream is still valid before creating recorder
      if (!currentStreamRef.current) {
        console.error(
          "Cannot create recorder: stream became null unexpectedly.",
        );
        setError("Stream not available.");
        setRecorderStatus("error");
        return;
      }
      const options = { mimeType: recorderMimeTypeRef.current };
      const newRecorder = new MediaRecorder(currentStreamRef.current, options);
      mediaRecorderRef.current = newRecorder; // Update ref

      // Clear previous buffer when starting anew
      recordedChunksRef.current = [];

      newRecorder.onerror = handleRecorderError;
      // *** Still need handleDataAvailable to collect chunks for the long recording ***
      newRecorder.ondataavailable = handleDataAvailable;

      // Handle state changes
      newRecorder.onstart = () => {
        console.log("Recorder actually started, setting status to recording.");
        setRecorderStatus("recording");
        // --- Set start time and auto-stop timer ---
        currentRecordingStartTimeRef.current = Date.now();
        if (maxRecordingTimeoutRef.current) {
          clearTimeout(maxRecordingTimeoutRef.current);
        }
        maxRecordingTimeoutRef.current = setTimeout(() => {
          console.log(
            "Max recording duration reached, stopping current recorder automatically.",
          );
          if (
            mediaRecorderRef.current &&
            mediaRecorderRef.current.state === "recording"
          ) {
            mediaRecorderRef.current.stop(); // Trigger onstop -> processRecording
          }
        }, MAX_RECORD_DURATION_MS - 5000); // stop 5 sec before max to allow processing time?
      };

      // --- Updated onstop handler ---
      newRecorder.onstop = async () => {
        console.warn("Recorder stopped.");
        setRecorderStatus("stopped");
        // Clear the auto-stop timeout now that it's stopped
        if (maxRecordingTimeoutRef.current) {
          clearTimeout(maxRecordingTimeoutRef.current);
          maxRecordingTimeoutRef.current = null;
        }

        // Check if the stop was intentionally triggered for processing
        if (processIntentRef.current) {
          console.log("Intentional trigger detected, processing recording...");
          // Reset the intent flag
          processIntentRef.current = false;
          // Process the collected recording (which will restart recorder after ffmpeg)
          await processRecording();
        } else {
          // Stop was likely due to timeout or other non-trigger reason
          console.log(
            "Stop was not intentionally triggered. Discarding recording and restarting.",
          );
          // Clear buffer and start time, then restart immediately
          recordedChunksRef.current = [];
          currentRecordingStartTimeRef.current = null;
          createAndStartRecorder();
        }
      };

      // --- Start recorder without timeslice for one long recording ---
      newRecorder.start();
      console.log("Recorder started continuously (no timeslice).");
    } catch (recorderError) {
      console.error("Failed to create/start MediaRecorder:", recorderError);
      setError(
        `Failed to initialize video recorder: ${recorderError instanceof Error ? recorderError.message : String(recorderError)}`,
      );
      mediaRecorderRef.current = null; // Ensure ref is null on error
      setRecorderStatus("error"); // Update status on error
    }
  }

  // Initialize and terminate FFmpeg worker
  useEffect(() => {
    console.log("Initializing FFmpeg worker...");
    const worker = new Worker("/ffmpeg-worker-webm.js"); // Path relative to public dir
    ffmpegWorkerRef.current = worker;

    const handleWorkerMessage = (event: MessageEvent) => {
      const msg = event.data as FFmpegWorkerMessage | FFmpegWorkerDoneMessage;
      switch (msg.type) {
        case "ready":
          console.log("FFmpeg worker ready.");
          break;
        case "stdout":
          console.log("FFmpeg stdout:", msg.data);
          break;
        case "stderr":
          console.log("FFmpeg stderr:", msg.data);
          break;
        case "error":
          console.error("FFmpeg worker error:", msg.data);
          const errorDetail1 =
            msg.data instanceof Error
              ? msg.data.message
              : "Non-Error data received";
          setError(`FFmpeg processing failed: ${errorDetail1}`);
          setIsProcessing(false);
          break;
        case "abort":
          console.error("FFmpeg worker aborted:", msg.data);
          const errorDetail2 =
            msg.data instanceof Error
              ? msg.data.message
              : "Non-Error data received";
          setError(`FFmpeg processing aborted: ${errorDetail2}`);
          setIsProcessing(false);
          break;
        case "done":
          console.log("FFmpeg processing done. Received message:", msg);
          // Check if 'data' property exists and is an object
          if (
            "data" in msg &&
            typeof msg.data === "object" &&
            msg.data !== null &&
            "MEMFS" in msg.data &&
            Array.isArray(msg.data.MEMFS)
          ) {
            // Log the received MEMFS array
            console.log("Received MEMFS data:", msg.data.MEMFS);
            const output = msg.data.MEMFS.find(
              (f: FFmpegOutputFile) => f?.name === "output.webm",
            );
            // Log the result of the find operation
            console.log("Result of finding 'output.webm':", output);
            // Check if output exists, data exists, and data has byteLength property
            if (output?.data && typeof output.data.byteLength === "number") {
              console.log(
                `Received processed file: ${output.name}, size: ${output.data.byteLength}, type: ${output.data.constructor.name}`,
              );
              const baseMimeType =
                recorderMimeTypeRef.current?.split(";")[0] ?? "video/webm";
              const resultBlob = new Blob([output.data], {
                type: baseMimeType,
              });

              // No longer revoking single URL here, handled in state update

              const newUrl = URL.createObjectURL(resultBlob);
              const newClip: LoopClip = {
                id: Date.now().toString(), // Use current time as ID
                url: newUrl,
                timestamp: Date.now(),
              };

              // Update clip list state, add new clip, limit list size, revoke old URLs
              setLoopClips((prevClips) => {
                const updatedClips = [newClip, ...prevClips];
                const clipsToKeep = updatedClips.slice(0, MAX_SAVED_CLIPS);
                const clipsToRemove = updatedClips.slice(MAX_SAVED_CLIPS);

                clipsToRemove.forEach((clip) => {
                  console.log(
                    `Max clips reached. Revoking oldest clip URL: ${clip.url}`,
                  );
                  URL.revokeObjectURL(clip.url);
                  // Also remove from videoRefs map if it exists
                  videoRefs.current.delete(clip.id);
                });

                // Auto-select the newly added clip
                // setSelectedClipId(newClip.id); // Moved to useEffect

                return clipsToKeep;
              });

              setError(null);

              // --- Play notification sound ---
              try {
                // NOTE: User must place a sound file named 'ding.mp3'
                // (or update path) in the /public directory.
                const notificationSound = new Audio("/glass.mp3");
                notificationSound.play().catch((err) => {
                  // Autoplay policies might prevent sound without prior user interaction
                  console.warn("Could not play notification sound:", err);
                });
              } catch (err) {
                console.error(
                  "Error creating/playing notification sound:",
                  err,
                );
              }
              // --------------------------------
            } else {
              console.error(
                "FFmpeg finished but output file 'output.webm' not found or data invalid.",
                "Output object structure:",
                output,
                "Does data have byteLength?",
                typeof output?.data?.byteLength === "number", // Log check result
              );
              setError("FFmpeg processing failed to produce valid output.");
            }
          } else {
            console.error("FFmpeg finished but no data received.");
            setError("FFmpeg processing failed to return data.");
          }
          setIsProcessing(false);
          break;
        case "run":
          break;
        case "exit":
          break;
        default:
          console.warn(
            "Received unknown message type from FFmpeg worker:",
            msg,
          );
      }
    };

    worker.onmessage = handleWorkerMessage;
    worker.onerror = (err) => {
      console.error("FFmpeg worker onerror:", err);
      setError(`FFmpeg worker failed: ${err.message}`);
      setIsProcessing(false);
      ffmpegWorkerRef.current = null; // Worker likely unusable now
    };

    return () => {
      console.log("Terminating FFmpeg worker...");
      worker?.terminate();
      ffmpegWorkerRef.current = null;
    };
  }, []); // No dependencies - relies only on refs and constants

  // --- Initialize and manage Porcupine Wake Word Detection ---
  useEffect(() => {
    // Get the Picovoice AccessKey from environment variables
    const ACCESS_KEY = env.NEXT_PUBLIC_PICOVOICE_ACCESS_KEY;

    // Define the wake word model configuration
    const porcupineKeyword = {
      publicPath: "/porcupine_models/save-it_en_wasm_v3_0_0.ppn",
      label: "save it", // Update label to match the actual wake word
    };

    // Define the Porcupine model
    const porcupineModel = {
      publicPath: "/porcupine_models/porcupine_params.pv",
    };

    console.log("Initializing Porcupine wake word detection...");

    // Initialize Porcupine
    initPorcupine(ACCESS_KEY, porcupineKeyword, porcupineModel).catch(
      (error) => {
        console.error("Failed to initialize Porcupine:", error);
        setSpeechError(
          `Failed to initialize wake word detection: ${String(error)}`,
        );
        setIsPorcupineSupported(false);
      },
    );

    // Cleanup function
    return () => {
      if (isPorcupineListening) {
        console.log("Releasing Porcupine resources...");
        void releasePorcupine();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Run only once on mount

  // Handle wake word detection
  useEffect(() => {
    if (keywordDetection !== null) {
      // Type-safe access to label with fallback
      const label =
        typeof keywordDetection === "object" && keywordDetection !== null
          ? String(keywordDetection?.label ?? "unknown")
          : "unknown";

      console.log(`Wake word detected: ${label}`);
      setSpeechError(null); // Clear previous errors on successful detection

      // Trigger the loop action when wake word is detected
      void handleLoopTrigger();
    }
  }, [keywordDetection]);

  // Update UI state based on Porcupine state
  useEffect(() => {
    setIsListening(isPorcupineListening);

    if (porcupineError) {
      console.error("Porcupine error:", porcupineError);
      const errorMessage =
        typeof porcupineError === "object" && porcupineError !== null
          ? String(porcupineError)
          : "Unknown error";
      setSpeechError(`Wake word detection error: ${errorMessage}`);
    }
  }, [isPorcupineListening, porcupineError]);

  // --- Speech Recognition Control Functions ---
  const startListening = useCallback(() => {
    if (isPorcupineLoaded && !isPorcupineListening) {
      console.log("Starting wake word detection...");
      try {
        setSpeechError(null);
        void startPorcupine();
      } catch (e) {
        console.error("Error starting wake word detection:", e);
        setSpeechError(
          `Failed to start wake word detection: ${e instanceof Error ? e.message : String(e)}`,
        );
        setIsListening(false);
      }
    }
  }, [isPorcupineLoaded, isPorcupineListening, startPorcupine]);

  const stopListening = useCallback(() => {
    if (isPorcupineListening) {
      console.log("Stopping wake word detection...");
      void stopPorcupine();
    }
  }, [isPorcupineListening, stopPorcupine]);

  // --- Updated handleLoopTrigger (Checks ref state instead of prop state) ---
  const handleLoopTrigger = useCallback(async () => {
    const worker = ffmpegWorkerRef.current;

    if (isProcessing) {
      console.warn("Already processing, ignoring trigger.");
      return;
    }

    if (!worker) {
      console.error("FFmpeg worker not available.");
      setError("Processing worker is not ready.");
      return;
    }

    // --- Check recorder state via REF ---
    if (mediaRecorderRef.current?.state !== "recording") {
      console.warn(
        "Cannot generate loop: Recorder not active. State:",
        mediaRecorderRef.current?.state,
      );
      setError("Recorder is not active. Cannot generate loop.");
      return;
    }

    // MimeType check (still relevant for processing)
    if (!recorderMimeTypeRef.current) {
      console.error("Cannot generate loop: MimeType missing.");
      setError("Recorder mime type not set. Cannot generate loop.");
      return;
    }

    console.log(
      "Trigger pressed or spoken. Stopping recorder to process clip...",
    );

    // Clear auto-stop timeout if user triggers first
    if (maxRecordingTimeoutRef.current) {
      clearTimeout(maxRecordingTimeoutRef.current);
      maxRecordingTimeoutRef.current = null;
    }

    // Set the intent flag BEFORE stopping the recorder
    processIntentRef.current = true;
    console.log("Setting process intent flag to true.");

    // Stop the current recorder. The onstop handler will call processRecording.
    mediaRecorderRef.current?.stop();
  }, [isProcessing]); // Only depends on isProcessing now

  // --- Handlers for Clip Actions ---
  const handleDownloadClip = useCallback((clip: LoopClip) => {
    const link = document.createElement("a");
    link.href = clip.url;
    // Format timestamp for filename (e.g., YYYYMMDD_HHMMSS)
    const date = new Date(clip.timestamp);
    const formattedTime = `${date.getFullYear()}${(date.getMonth() + 1).toString().padStart(2, "0")}${date.getDate().toString().padStart(2, "0")}_${date.getHours().toString().padStart(2, "0")}${date.getMinutes().toString().padStart(2, "0")}${date.getSeconds().toString().padStart(2, "0")}`;
    link.download = `loop-clip-${formattedTime}.webm`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    console.log(`Download triggered for clip: ${clip.id}`);
  }, []);

  const handleRemoveClip = useCallback(
    (clipIdToRemove: string) => {
      setLoopClips((prevClips) => {
        const clipToRemove = prevClips.find(
          (clip) => clip.id === clipIdToRemove,
        );
        const remainingClips = prevClips.filter(
          (clip) => clip.id !== clipIdToRemove,
        );

        if (clipToRemove) {
          console.log(
            `Removing clip ${clipIdToRemove} and revoking URL: ${clipToRemove.url}`,
          );
          URL.revokeObjectURL(clipToRemove.url);
          // Remove from videoRefs map
          videoRefs.current.delete(clipIdToRemove);

          // If the removed clip was the selected one, select the new "first" clip or null
          if (selectedClipId === clipIdToRemove) {
            setSelectedClipId(remainingClips[0]?.id ?? null);
          }
        } else {
          console.warn(
            `Attempted to remove clip ${clipIdToRemove} but it was not found.`,
          );
        }
        return remainingClips;
      });
    },
    [selectedClipId],
  );

  // --- Playback Control Handlers for Selected Clip ---
  const handleTogglePlayPause = useCallback(() => {
    if (!selectedClipId) return;
    const video = videoRefs.current.get(selectedClipId);
    if (!video) return;

    if (video.paused) {
      console.log(`Button: Playing selected video ${selectedClipId}`);
      void video.play().then(() => setIsSelectedClipPlaying(true));
    } else {
      console.log(`Button: Pausing selected video ${selectedClipId}`);
      video.pause();
      setIsSelectedClipPlaying(false);
    }
  }, [selectedClipId]);

  const handleFrameStep = useCallback(
    (direction: "forward" | "backward", count: number) => {
      if (!selectedClipId) return;
      const video = videoRefs.current.get(selectedClipId);
      if (!video) return;

      video.pause(); // Always pause before stepping
      setIsSelectedClipPlaying(false);

      const currentFrameDuration = 1 / 30; // Assuming 30fps for stepping
      const jump =
        count * currentFrameDuration * (direction === "forward" ? 1 : -1);
      const newTime = Math.max(
        0,
        Math.min(video.duration, video.currentTime + jump),
      );
      video.currentTime = newTime;
      // Update state immediately after manual step
      setSelectedClipTime(newTime);
      console.log(
        `Button: Stepped ${count} frame(s) ${direction} on ${selectedClipId}`,
      );
    },
    [selectedClipId], // Depends on selectedClipId
  );

  // --- Debounced Video Seek Function ---
  const debouncedSeek = useCallback(
    (time: number) => {
      if (!selectedClipId) return;
      const video = videoRefs.current.get(selectedClipId);
      if (video) {
        // Ensure seeking doesn't start playback if paused
        const wasPaused = video.paused;
        console.log(
          `Slider (debounced): Seeking video ${selectedClipId} to ${time.toFixed(3)}s`,
        );
        video.currentTime = time;
        if (wasPaused) {
          video.pause();
        }
      }
    },
    [selectedClipId],
  ); // Depends on selectedClipId

  // --- Slider Value Change Handler ---
  const handleSliderChange = useCallback(
    (value: number[]) => {
      const newTime = value[0];
      // Check if newTime is a valid number before proceeding
      if (typeof newTime === "number" && Number.isFinite(newTime)) {
        // Update state immediately for responsive UI
        setSelectedClipTime(newTime);

        // Clear any existing seek timeout
        if (seekTimeoutRef.current) {
          clearTimeout(seekTimeoutRef.current);
        }

        // Set a new timeout to seek the video after a short delay
        seekTimeoutRef.current = setTimeout(() => {
          debouncedSeek(newTime);
        }, 50); // 50ms debounce delay
      }
    },
    [debouncedSeek],
  ); // Depends on debouncedSeek callback

  // --- Effect to auto-select the newest clip OR handle selection removal --- (Revised Again)
  useEffect(() => {
    const newestClipId = loopClips[0]?.id ?? null;

    // Read the current selected ID directly from state within the effect
    // We don't need it as a dependency, which caused the override issue.
    const currentSelectedClipId = selectedClipId;

    // Condition 1: No clip currently selected, but clips exist -> Select newest
    if (!currentSelectedClipId && newestClipId) {
      console.log(`Auto-selecting initial/newest clip: ${newestClipId}`);
      setSelectedClipId(newestClipId);
    }
    // Condition 2: A clip IS selected, but it's no longer in the list -> Select newest (or null)
    else if (
      currentSelectedClipId &&
      !loopClips.some((clip) => clip.id === currentSelectedClipId)
    ) {
      console.log(
        `Selected clip ${currentSelectedClipId} removed. Selecting newest: ${newestClipId ?? "none"}`,
      );
      setSelectedClipId(newestClipId); // Select newest, or null if list is now empty
    }
    // Condition 3: Clips list is empty and a selection still exists -> Clear selection
    else if (loopClips.length === 0 && currentSelectedClipId) {
      console.log("Clips list empty, clearing selection.");
      setSelectedClipId(null);
    }

    // This effect should only run when the list of clips changes.
  }, [loopClips]); // <<< Dependency ONLY on loopClips

  // Main effect for camera access and recorder setup
  useEffect(() => {
    let didCancel = false;

    const setup = async () => {
      if (!selectedDeviceId) return; // Wait for device selection

      console.log("Setup: Getting user media for device:", selectedDeviceId);
      // --- Stop existing recorder and stream before getting new one ---
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        console.log("Setup: Stopping previous recorder.");
        recorder.stop();
        // recorder.onstop = null; // Let the default handler run if needed, or null it
      }
      mediaRecorderRef.current = null; // Clear ref

      if (currentStreamRef.current) {
        console.log("Setup: Stopping previous stream tracks.");
        currentStreamRef.current.getTracks().forEach((track) => track.stop());
        currentStreamRef.current = null; // Clear ref
      }
      // Clear buffer and displayed clip -> Now clear array
      recordedChunksRef.current = [];
      // Clear state and revoke any existing clip URLs before setup
      setLoopClips((prevClips) => {
        prevClips.forEach((clip) => URL.revokeObjectURL(clip.url));
        return [];
      });
      // -------------------------------------------------------------

      try {
        const newStream = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: { exact: selectedDeviceId } },
          audio: false,
        });
        if (didCancel) {
          newStream.getTracks().forEach((track) => track.stop());
          return;
        }

        currentStreamRef.current = newStream; // Store stream in ref
        if (videoRef.current) {
          videoRef.current.srcObject = newStream;
        }

        const supportedMimeType = PREFERRED_MIME_TYPES.find((type) =>
          MediaRecorder.isTypeSupported(type),
        );
        if (!supportedMimeType) {
          setError("Browser lacks suitable video recording format support.");
          return;
        }
        recorderMimeTypeRef.current = supportedMimeType;

        // Initial recorder start (only one recorder instance now)
        createAndStartRecorder();

        // Removed interval setup
      } catch (err) {
        if (!didCancel) {
          console.error("Error accessing camera / setting up recorder:", err);
          setError(
            `Camera/Recorder setup failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    };

    const cleanup = () => {
      didCancel = true;
      console.log("Cleanup: Stopping recorder, stream, revoking clip URLs...");
      // Removed interval cleanup
      // Stop recorder
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        console.log("Cleanup: Stopping recorder.");
        // Remove listeners before stopping? Might prevent late errors/data events
        recorder.onerror = null;
        recorder.ondataavailable = null;
        recorder.onstop = null;
        try {
          recorder.stop();
        } catch (e) {
          console.error("Cleanup: Error stopping recorder", e);
        }
      }
      mediaRecorderRef.current = null;
      // Revoke all current clip URLs from state
      setLoopClips((prevClips) => {
        console.log(`Cleanup: Revoking ${prevClips.length} clip URLs.`);
        prevClips.forEach((clip) => {
          try {
            URL.revokeObjectURL(clip.url);
          } catch (e) {
            console.error("Error revoking URL during cleanup:", e);
          }
        });
        return []; // Clear the array
      });
      // Stop stream tracks
      if (currentStreamRef.current) {
        console.log("Cleanup: Stopping stream tracks.");
        currentStreamRef.current.getTracks().forEach((track) => track.stop());
        currentStreamRef.current = null;
      }
      // Reset refs and state
      recordedChunksRef.current = [];
      recorderMimeTypeRef.current = null;
      setError(null); // Clear error on cleanup/device change
    };

    void setup(); // Run setup and ignore the promise

    return cleanup; // Return cleanup function
    // Only re-run when the selected device changes.
  }, [selectedDeviceId]); // Removed createAndStartRecorder from dependencies

  // --- Keyboard Controls Effect ---
  useEffect(() => {
    // Only attach listener if there is a selected clip
    if (!selectedClipId) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      // Check if the event target is an input, select, textarea, etc. to avoid interference
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLSelectElement ||
        event.target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      // Reuse handlers defined above - they now use selectedClipId
      switch (event.key) {
        case " ":
          event.preventDefault();
          handleTogglePlayPause();
          break;
        case "ArrowRight":
          event.preventDefault();
          handleFrameStep("forward", event.shiftKey ? 5 : 1);
          break;
        case "ArrowLeft":
          event.preventDefault();
          handleFrameStep("backward", event.shiftKey ? 5 : 1);
          break;
        default:
          break;
      }
    };

    console.log(
      `Attaching keyboard listener for selected clip: ${selectedClipId}`,
    );
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      console.log(`Removing keyboard listener for clip: ${selectedClipId}`);
      window.removeEventListener("keydown", handleKeyDown);
    };
    // Re-attach if the selected clip changes
  }, [selectedClipId, handleTogglePlayPause, handleFrameStep]);

  // --- Effect to Reset/Update Playback State for Selected Clip --- (Revised for Autoplay)
  useEffect(() => {
    if (!selectedClipId) {
      // If no clip is selected, reset state
      setSelectedClipTime(0);
      setSelectedClipDuration(0);
      setIsSelectedClipPlaying(false);
      return;
    }

    const video = videoRefs.current.get(selectedClipId);

    // Pause and mute all other videos first
    videoRefs.current.forEach((otherVideo, otherId) => {
      if (otherVideo && otherId !== selectedClipId) {
        otherVideo.pause();
        otherVideo.muted = true;
      }
    });

    if (video) {
      // When selected clip changes, update state from the video element
      const duration = video.duration;
      const currentTime = video.currentTime;
      const isActuallyPlaying =
        !video.paused && !video.ended && video.readyState > 2;

      setSelectedClipDuration(Number.isFinite(duration) ? duration : 0);
      setSelectedClipTime(Number.isFinite(currentTime) ? currentTime : 0);
      // Update playing state based on actual video state
      setIsSelectedClipPlaying(isActuallyPlaying);

      // Attempt to play the newly selected video
      console.log(
        `Effect: Ensuring selected clip ${selectedClipId} is playing.`,
      );
      video.muted = false; // Unmute the selected video
      video
        .play()
        .then(() => {
          // Successfully started playing (or was already playing)
          setIsSelectedClipPlaying(true);
          console.log(`Effect: Play initiated for ${selectedClipId}`);
        })
        .catch((err) => {
          console.error(`Autoplay for ${selectedClipId} failed:`, err);
          // If autoplay fails (e.g., browser policy), ensure state is paused
          setIsSelectedClipPlaying(false);
          // Don't re-mute here, user might want to manually unmute/play
        });

      console.log(
        `Selected clip ${selectedClipId}. Initial state - Duration: ${duration}, Time: ${currentTime}, Playing: ${isActuallyPlaying}`,
      );
    } else {
      // Video ref might not be available immediately after selection, reset state
      setSelectedClipTime(0);
      setSelectedClipDuration(0);
      setIsSelectedClipPlaying(false);
      console.log(
        `Selected clip ${selectedClipId}, but video ref not found yet. Resetting state.`,
      );
    }

    // Cleanup timeout ref when selected clip changes
    return () => {
      if (seekTimeoutRef.current) {
        clearTimeout(seekTimeoutRef.current);
      }
    };
  }, [selectedClipId]); // Depend only on the selected clip ID

  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-4 md:p-24">
      <Card className="w-full max-w-3xl">
        <CardHeader>
          <CardTitle>Live Camera Feed & Auto Clips</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {error && (
            <Alert variant="destructive">
              <Terminal className="h-4 w-4" />
              <AlertTitle>Error</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {/* --- Camera Selection --- */}
          <div className="flex items-center gap-4">
            <Select
              value={selectedDeviceId}
              onValueChange={setSelectedDeviceId}
              disabled={devices.length === 0}
            >
              <SelectTrigger className="w-[280px]">
                <SelectValue placeholder="Select a camera" />
              </SelectTrigger>
              <SelectContent>
                {devices.map((device) => (
                  <SelectItem key={device.deviceId} value={device.deviceId}>
                    {device.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* --- Target Duration Input --- */}
          <div className="flex items-center gap-2 pt-2">
            <Label htmlFor="clipDuration" className="whitespace-nowrap">
              Target Clip Duration (ms):
            </Label>
            <Input
              id="clipDuration"
              type="number"
              value={targetDurationInputMs}
              onChange={(e) => setTargetDurationInputMs(e.target.value)}
              min="500" // Set a reasonable min
              step="100"
              className="w-[100px]"
              disabled={isProcessing} // Disable only while ffmpeg is processing
            />
          </div>

          {/* --- Live Video Display --- */}
          <div className="bg-muted aspect-video w-full overflow-hidden rounded-md border">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="h-full w-full object-cover"
            />
          </div>

          {/* --- Controls Row --- */}
          <div className="flex items-center justify-center gap-4 pt-4">
            {/* --- Trigger Button --- */}
            <Button
              onClick={handleLoopTrigger}
              disabled={recorderStatus !== "recording" || isProcessing}
              size="lg"
            >
              {isProcessing ? (
                <Loader2 className="mr-2 h-5 w-5 animate-spin" />
              ) : (
                <Play className="mr-2 h-5 w-5" />
              )}
              {isProcessing ? "Processing..." : "Trigger Loop"}
            </Button>

            {/* --- Speech Recognition Controls --- */}
            {isPorcupineSupported ? (
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <Button
                    variant={isListening ? "destructive" : "outline"}
                    size="icon"
                    onClick={isListening ? stopListening : startListening}
                    title={
                      isListening ? "Stop Listening" : "Listening for 'save it'"
                    }
                  >
                    {isListening ? (
                      <MicOff className="h-5 w-5" />
                    ) : (
                      <Mic className="h-5 w-5" />
                    )}
                  </Button>
                  <span
                    className={`text-sm ${isListening ? "text-green-600" : "text-muted-foreground"}`}
                  >
                    {isListening ? "Listening for 'save it'..." : "Mic Off"}
                  </span>
                </div>
              </div>
            ) : (
              <p className="text-destructive text-sm">
                Wake word detection not supported.
              </p>
            )}
          </div>
          {/* Display Speech Errors */}
          {speechError && (
            <Alert variant="destructive" className="mt-2">
              <Terminal className="h-4 w-4" />
              <AlertTitle>Wake Word Detection Error</AlertTitle>
              <AlertDescription>{speechError}</AlertDescription>
            </Alert>
          )}

          {/* --- Auto Generated Clips -> Triggered Loop Clip --- */}
          {/* --- Saved Loop Clips --- */}
          <div className="flex flex-col gap-4 pt-4">
            {loopClips.length > 0 && (
              <h3 className="text-lg font-semibold">
                Recent Clips (Newest First)
              </h3>
            )}
            {loopClips.map((clip, index) => (
              <div
                key={clip.id}
                className={`flex flex-col gap-2 rounded-md border p-4 transition-all duration-150 ease-in-out ${
                  selectedClipId === clip.id
                    ? "border-primary ring-primary ring-2 ring-offset-2" // Highlight selected
                    : "border-border hover:border-muted-foreground/50" // Normal border
                }`}
                onClick={() => setSelectedClipId(clip.id)} // Select clip on click
              >
                <div className="bg-muted relative aspect-video w-full cursor-pointer overflow-hidden rounded-sm">
                  <video
                    ref={(el) => {
                      // Update the ref map
                      if (el) {
                        videoRefs.current.set(clip.id, el);
                      } else {
                        videoRefs.current.delete(clip.id);
                      }
                    }}
                    src={clip.url}
                    playsInline
                    loop
                    muted={clip.id !== selectedClipId} // Mute if not selected
                    className="h-full w-full object-cover"
                    onPlay={() => {
                      // This might fire briefly even if paused immediately by effect
                      if (clip.id === selectedClipId) {
                        // Correct state will be set by the effect watching selectedClipId
                        // setIsSelectedClipPlaying(true);
                      }
                    }}
                    onPause={() => {
                      if (clip.id === selectedClipId) {
                        // Correct state will be set by the effect watching selectedClipId
                        // setIsSelectedClipPlaying(false);
                      }
                    }}
                    onError={(e) => {
                      const videoElement = e.target as HTMLVideoElement;
                      console.error(
                        `Error playing clip ${clip.id} (URL: ${clip.url}):`,
                        videoElement.error,
                      );
                      // Optionally set an error state specific to this clip?
                    }}
                    // Add listeners only for the selected clip (state updates triggered by useEffect[selectedClipId])
                    onLoadedMetadata={(e) => {
                      if (clip.id === selectedClipId) {
                        const videoElement = e.target as HTMLVideoElement;
                        console.log(
                          `Selected clip ${selectedClipId} metadata loaded, duration:`,
                          videoElement.duration,
                        );
                        const durationValue = videoElement.duration;
                        if (
                          typeof durationValue === "number" &&
                          Number.isFinite(durationValue)
                        ) {
                          setSelectedClipDuration(durationValue);
                        } else {
                          setSelectedClipDuration(0);
                        }
                        // Also reset time when metadata loads for the selected clip
                        setSelectedClipTime(0);
                        videoElement.currentTime = 0;
                      }
                    }}
                    onTimeUpdate={(e) => {
                      if (clip.id === selectedClipId) {
                        const videoElement = e.target as HTMLVideoElement;
                        const timeValue = videoElement.currentTime;
                        if (
                          typeof timeValue === "number" &&
                          Number.isFinite(timeValue)
                        ) {
                          setSelectedClipTime(timeValue);
                        }
                        // No need to reset to 0 here, let it report the actual time
                      }
                    }}
                  />
                </div>
                {/* --- Clip Actions (Always visible) --- */}
                <div className="flex items-center justify-between gap-2 pt-2">
                  <span className="text-muted-foreground text-sm">
                    Captured: {new Date(clip.timestamp).toLocaleTimeString()}
                  </span>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDownloadClip(clip);
                      }} // Stop propagation
                    >
                      <Download className="mr-1 h-4 w-4" />
                      Download
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRemoveClip(clip.id);
                      }} // Stop propagation
                    >
                      <X className="mr-1 h-4 w-4" />
                      Remove
                    </Button>
                  </div>
                </div>
                {/* --- Add Playback Controls ONLY for the selected clip --- */}
                {selectedClipId === clip.id && (
                  <>
                    <div className="mt-2 flex items-center justify-center gap-2 border-t pt-2">
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Rewind 5 Frames (Shift+Left)"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleFrameStep("backward", 5);
                        }} // Stop propagation
                        disabled={!selectedClipDuration}
                      >
                        <Rewind className="h-5 w-5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Frame Back (Left Arrow)"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleFrameStep("backward", 1);
                        }} // Stop propagation
                        disabled={!selectedClipDuration}
                      >
                        <SkipBack className="h-5 w-5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Play/Pause (Space)"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleTogglePlayPause();
                        }} // Stop propagation
                        disabled={!selectedClipDuration}
                      >
                        {isSelectedClipPlaying ? (
                          <Pause className="h-5 w-5" />
                        ) : (
                          <Play className="h-5 w-5" />
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Frame Forward (Right Arrow)"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleFrameStep("forward", 1);
                        }} // Stop propagation
                        disabled={!selectedClipDuration}
                      >
                        <SkipForward className="h-5 w-5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Fast Forward 5 Frames (Shift+Right)"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleFrameStep("forward", 5);
                        }} // Stop propagation
                        disabled={!selectedClipDuration}
                      >
                        <FastForward className="h-5 w-5" />
                      </Button>
                    </div>
                    {/* --- Slider --- */}
                    <div
                      className="px-2 pt-1"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {" "}
                      {/* Stop propagation */}
                      <Slider
                        max={selectedClipDuration}
                        step={FRAME_DURATION} // Use defined constant
                        value={[selectedClipTime]}
                        disabled={!selectedClipDuration}
                        onValueChange={handleSliderChange}
                        className="h-2 w-full"
                      />
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
