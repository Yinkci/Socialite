# Socialite reply drafter: runs on Hugging Face ZeroGPU.
# The Socialite app sends its full reply rules as `system` and the comment data as `user`,
# and this Space returns the model's JSON draft as text. The app validates the result.
import os

import gradio as gr
import spaces
import torch
from transformers import AutoModelForMultimodalLM, AutoProcessor

MODEL_ID = os.environ.get("MODEL_ID", "Qwen/Qwen3.5-9B")

processor = AutoProcessor.from_pretrained(MODEL_ID)
# ZeroGPU: place the model on cuda at startup; a real GPU is attached only inside @spaces.GPU.
model = AutoModelForMultimodalLM.from_pretrained(MODEL_ID, dtype=torch.bfloat16).to("cuda")
model.eval()


@spaces.GPU(duration=40)
def draft(system: str, user: str, max_new_tokens: float = 400) -> str:
    messages = [
        {"role": "system", "content": [{"type": "text", "text": system}]},
        {"role": "user", "content": [{"type": "text", "text": user}]},
    ]
    inputs = processor.apply_chat_template(
        messages,
        add_generation_prompt=True,
        tokenize=True,
        return_dict=True,
        return_tensors="pt",
        enable_thinking=False,  # short replies: skip the hidden reasoning to save GPU quota
    ).to("cuda")
    limit = max(32, min(int(max_new_tokens or 400), 800))
    with torch.inference_mode():
        output = model.generate(**inputs, max_new_tokens=limit, do_sample=True, temperature=0.7, top_p=0.8, top_k=20)
    return processor.decode(output[0][inputs["input_ids"].shape[1]:], skip_special_tokens=True).strip()


with gr.Blocks(title="Socialite reply drafter") as demo:
    gr.Markdown("Private reply drafter used by the Socialite app. Call it through the API.")
    system = gr.Textbox(label="System", lines=4)
    user = gr.Textbox(label="User", lines=4)
    max_new_tokens = gr.Number(value=400, label="Max new tokens")
    result = gr.Textbox(label="Draft", lines=6)
    gr.Button("Draft").click(draft, [system, user, max_new_tokens], result, api_name="draft")

demo.queue(default_concurrency_limit=2).launch()
