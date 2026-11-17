import json,subprocess,hashlib,posixpath
from html.parser import HTMLParser
from pathlib import Path
out=Path(__file__).parent
class Includes(HTMLParser):
 def __init__(self):super().__init__();self.paths=[]
 def handle_starttag(self,tag,attrs):
  attrs=dict(attrs);src=attrs.get('src','')
  if tag not in ('script','img','iframe','source','video','audio','input','embed') and src and not src.startswith(('http:','https:','data:','//')):self.paths.append(src)
root_request={'method':'object.read','array':'files','filter':{'query':{'host':{'$in':['dev.cocreatejs.com','*']},'pathname':'/index.html'},'key':{'pathname':1,'src':1,'host':1,'_id':1},'limit':1}}
root_records={}
for storage in ('mongodb','db'):
 request=dict(root_request)
 if storage=='db':request['storage']='db'
 result=subprocess.run(['coc','send'],input=json.dumps(request),text=True,capture_output=True,cwd='/home/ubuntu/Dev',check=True)
 data=json.loads(result.stdout)
 if data.get('error')or not data.get('object'):raise RuntimeError(str(data.get('error') or 'Root file missing'))
 root_records[storage]=data['object'][0]
root=root_records['mongodb']
root_hashes={storage:hashlib.sha256(record['src'].encode()).hexdigest()for storage,record in root_records.items()}
assert root_hashes['mongodb']==root_hashes['db'],'Root source differs'
seen={'/index.html':root};pending=['/index.html'];checks=[]
while pending:
 paths=[]
 for path in pending:
  parser=Includes();parser.feed(seen[path].get('src',''))
  for src in parser.paths:
   target=posixpath.normpath(posixpath.join(posixpath.dirname(path),src))
   if target not in seen and target not in paths:paths.append(target)
 if not paths:break
 results={}
 for storage in ('mongodb','db'):
  request={'method':'object.read','array':'files','filter':{'query':{'host':{'$in':['dev.cocreatejs.com','*']},'pathname':{'$in':paths}},'key':{'pathname':1,'src':1,'host':1,'_id':1}}}
  if storage=='db':request['storage']='db'
  result=subprocess.run(['coc','send'],input=json.dumps(request),text=True,capture_output=True,cwd='/home/ubuntu/Dev',check=True)
  data=json.loads(result.stdout)
  if data.get('error')or data.get('success')is False:raise RuntimeError(str(data.get('error')))
  results[storage]={record['pathname']:record for record in data.get('object',[])}
 for path in paths:
  records=[results[storage].get(path) for storage in ('mongodb','db')]
  hashes=[hashlib.sha256(record.get('src','').encode()).hexdigest()if record else None for record in records]
  checks.append({'pathname':path,'mongodbSha256':hashes[0],'dbSha256':hashes[1],'equal':hashes[0]==hashes[1],'bothMissing':hashes[0] is None and hashes[1] is None})
  if records[0]:seen[path]=records[0]
 pending=[path for path in paths if path in seen]
report={'rootSha256':root_hashes['mongodb'],'root':{'mongodbSha256':root_hashes['mongodb'],'dbSha256':root_hashes['db'],'equal':True},'componentCount':len(checks),'allEqual':all(check['equal'] for check in checks),'components':checks,'matchedSourceFiles':1+sum(item['equal'] and not item['bothMissing'] for item in checks),'missingInBoth':[item['pathname'] for item in checks if item['bothMissing']]}
(out/'source-comparison.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({key:value for key,value in report.items()if key!='components'}))
for item in checks:
 if not item['equal']:print('MISMATCH',item['pathname'])
