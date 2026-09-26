"use client";

import jsQR from "jsqr";
import { useEffect, useRef, useState } from "react";

import { Icon } from "@/components/app/kit";

/**
 * Reads a UPI QR (upi://pay?…) from the camera or from a photo, entirely in the
 * browser (jsQR). The camera needs a secure page (https or localhost); a photo
 * upload works everywhere.
 */
export function QrScanner({ onResult }: { onResult: (text: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const [scanning, setScanning] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const stop = () => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    setScanning(false);
  };
  useEffect(() => stop, []);

  function decode(source: CanvasImageSource, w: number, h: number) {
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, 1000 / Math.max(w, h));
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return jsQR(img.data, img.width, img.height)?.data ?? null;
  }

  function found(text: string) {
    if (!/^upi:\/\/pay\?/i.test(text.trim())) {
      setMsg("That QR isn't a UPI payment QR.");
      return false;
    }
    setMsg(null);
    onResult(text.trim());
    return true;
  }

  async function startCamera() {
    setMsg(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setMsg("This browser can't use the camera here — upload a photo of the QR instead.");
      return;
    }
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      setScanning(true);
      const v = video.current!;
      v.srcObject = stream.current;
      await v.play();
      const tick = () => {
        if (!stream.current) return;
        if (v.readyState >= 2 && v.videoWidth) {
          const text = decode(v, v.videoWidth, v.videoHeight);
          if (text && found(text)) return stop();
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    } catch {
      stop();
      setMsg("Camera not available (permission denied or no camera) — upload a photo of the QR instead.");
    }
  }

  function fromFile(file: File) {
    setMsg(null);
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const text = decode(img, img.naturalWidth, img.naturalHeight);
      URL.revokeObjectURL(url);
      if (!text) setMsg("Couldn't find a QR in that photo — try a closer, sharper picture.");
      else found(text);
    };
    img.onerror = () => setMsg("Couldn't open that image.");
    img.src = url;
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="relative mx-auto flex h-48 w-48 items-center justify-center overflow-hidden rounded-2xl bg-inverse-surface/90">
        <video ref={video} muted playsInline className={scanning ? "absolute inset-0 h-full w-full object-cover" : "hidden"} />
        {["left-2 top-2 border-l-4 border-t-4", "right-2 top-2 border-r-4 border-t-4", "bottom-2 left-2 border-b-4 border-l-4", "bottom-2 right-2 border-b-4 border-r-4"].map((c) => (
          <span key={c} className={`absolute z-10 h-7 w-7 rounded-sm border-primary-fixed ${c}`} />
        ))}
        {scanning ? null : <Icon name="qr_code_2" className="text-[64px] text-inverse-on-surface/70" />}
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => (scanning ? stop() : void startCamera())}
          className="flex h-11 flex-1 items-center justify-center gap-1.5 rounded-xl bg-primary-container font-label-md text-label-md text-on-primary"
        >
          <Icon name={scanning ? "stop_circle" : "photo_camera"} className="text-[18px]" />
          {scanning ? "Stop camera" : "Scan with camera"}
        </button>
        <label className="flex h-11 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-xl bg-surface-container font-label-md text-label-md text-on-surface">
          <Icon name="image" className="text-[18px]" />
          Upload QR photo
          <input
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) fromFile(f);
              e.target.value = "";
            }}
          />
        </label>
      </div>
      {msg ? <p className="text-center font-label-sm text-label-sm text-error">{msg}</p> : null}
    </div>
  );
}
