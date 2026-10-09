import base64, json, os, sys, urllib.request
img, prompt = sys.argv[1], sys.argv[2]
b = base64.b64encode(open(img,'rb').read()).decode()
req = urllib.request.Request(
    os.environ["OPENAI_API_BASE"].rstrip('/') + "/chat/completions",
    data=json.dumps({"model":"default","max_tokens":1500,"messages":[{"role":"user","content":[
        {"type":"text","text":prompt},
        {"type":"image_url","image_url":{"url":f"data:image/jpeg;base64,{b}"}}]}]}).encode(),
    headers={"Authorization":"Bearer "+os.environ["OPENAI_API_KEY"],"Content-Type":"application/json"})
print(json.loads(urllib.request.urlopen(req, timeout=120).read())["choices"][0]["message"]["content"])
