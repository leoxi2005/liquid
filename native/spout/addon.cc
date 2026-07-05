// Minimal Spout sender addon (Windows only).
// The renderer already produces BGRA top-down frames on the GPU for NDI;
// SpoutDX's default shared-texture format is DXGI_FORMAT_B8G8R8A8_UNORM and
// SendImage() uploads the bytes verbatim — the exact same buffer works here.

#include <napi.h>
#include <map>
#include <memory>
#include <string>

#include "SpoutDX.h"

static std::map<std::string, std::unique_ptr<spoutDX>> g_senders;

// send(name: string, pixels: Uint8Array /* BGRA top-down */, width, height) -> bool
static Napi::Value Send(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 4 || !info[0].IsString() || !info[1].IsTypedArray()) {
    return Napi::Boolean::New(env, false);
  }
  const std::string name = info[0].As<Napi::String>().Utf8Value();
  Napi::Uint8Array pixels = info[1].As<Napi::Uint8Array>();
  const uint32_t width = info[2].As<Napi::Number>().Uint32Value();
  const uint32_t height = info[3].As<Napi::Number>().Uint32Value();
  if (width == 0 || height == 0) return Napi::Boolean::New(env, false);
  if (pixels.ByteLength() < static_cast<size_t>(width) * height * 4) {
    return Napi::Boolean::New(env, false);
  }

  auto it = g_senders.find(name);
  if (it == g_senders.end()) {
    auto sender = std::make_unique<spoutDX>();
    if (!sender->OpenDirectX11()) return Napi::Boolean::New(env, false);
    sender->SetSenderName(name.c_str());
    it = g_senders.emplace(name, std::move(sender)).first;
  }
  const bool ok = it->second->SendImage(pixels.Data(), width, height);
  return Napi::Boolean::New(env, ok);
}

// close(name: string)
static Napi::Value Close(const Napi::CallbackInfo& info) {
  if (info.Length() >= 1 && info[0].IsString()) {
    auto it = g_senders.find(info[0].As<Napi::String>().Utf8Value());
    if (it != g_senders.end()) {
      it->second->ReleaseSender();
      it->second->CloseDirectX11();
      g_senders.erase(it);
    }
  }
  return info.Env().Undefined();
}

// closeAll()
static Napi::Value CloseAll(const Napi::CallbackInfo& info) {
  for (auto& entry : g_senders) {
    entry.second->ReleaseSender();
    entry.second->CloseDirectX11();
  }
  g_senders.clear();
  return info.Env().Undefined();
}

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("send", Napi::Function::New(env, Send));
  exports.Set("close", Napi::Function::New(env, Close));
  exports.Set("closeAll", Napi::Function::New(env, CloseAll));
  return exports;
}

NODE_API_MODULE(spout_addon, Init)
