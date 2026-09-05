const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
(async () => {
  const r = await import('../dist/packages/product-runtime/src/canonical-runtime.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'text-update-'));
  const hash = (s) => r.mutationContentHash(Buffer.from(s));
  const source = 'original\r\n';
  const claim = (content = 'changed\r\n', file = 'a.txt') => ({ claimVersion: 'text-file-update/v1', type: 'patch_draft', operation: 'update', file, description: 'Update text.', expectedContentHash: hash(source), newContent: content });
  const mutation = (claims = [claim()]) => ({ role: 'coder', target: 'patchDraft', summary: 'Update.', claims, touchedFiles: claims.map(c => c.file) });
  const verify = (m) => r.verifyPatchDraftMutationV2({ repositoryPath: root, mutation: m, allowedFiles: m.touchedFiles, boundContextFiles: m.touchedFiles.map(file => ({ path: file, contentHash: hash(source) })) });
  let checks = 0;
  const rejects = (m, code) => { assert.throws(() => r.parseTextFileUpdates(m), e => e.code === code); checks++; };
  try {
    await fs.writeFile(path.join(root, 'a.txt'), source);
    for (const op of ['create','delete','rename']) rejects(mutation([{ ...claim(), operation: op }]), `MUTATION_${op.toUpperCase()}_UNSUPPORTED`);
    for (const [extras, code] of [[{mode: '100755'}, 'MUTATION_MODE_CHANGE_UNSUPPORTED'], [{symlinkTarget:'x'}, 'MUTATION_SYMLINK_UNSUPPORTED'], [{binary:true}, 'MUTATION_BINARY_UNSUPPORTED'], [{proposedPatch:'x'}, 'MUTATION_LEGACY_PATCH_FIELD'], [{extra:true}, 'MUTATION_SCHEMA_INVALID'], [{newContent:'\0'}, 'MUTATION_BINARY_UNSUPPORTED'], [{newContent:'\ud800'}, 'MUTATION_UTF8_INVALID']]) rejects(mutation([{ ...claim(), ...extras }]), code);
    rejects(mutation([claim(),claim()]), 'MUTATION_DUPLICATE_FILE');
    rejects({ ...mutation([claim('one', 'a.txt'), claim('two', 'b.txt')]), touchedFiles: ['a.txt', 'a.txt'] }, 'MUTATION_DUPLICATE_FILE');
    rejects({ ...mutation([claim('one', 'a.txt')]), touchedFiles: ['a.txt', 'a.txt'] }, 'MUTATION_DUPLICATE_FILE');
    rejects({ ...mutation([claim('one', 'a.txt')]), touchedFiles: ['./a.txt'] }, 'MUTATION_SCHEMA_INVALID');
    assert.deepEqual(r.parseTextFileUpdates({ ...mutation([claim('one', 'a.txt'), claim('two', 'b.txt')]), touchedFiles: ['b.txt', 'a.txt'] }).map(c => c.file), ['a.txt', 'b.txt']); checks++;
    const limit = r.MUTATION_LIMITS.maxFileBytes;
    for (const n of [limit-1,limit]) { r.parseTextFileUpdates(mutation([claim('x'.repeat(n))])); checks++; }
    rejects(mutation([claim('x'.repeat(limit+1))]), 'MUTATION_FILE_LIMIT_EXCEEDED');
    rejects(mutation([claim('é'.repeat(limit/2+1))]), 'MUTATION_FILE_LIMIT_EXCEEDED');
    r.parseTextFileUpdates(mutation(Array.from({length:4}, (_,i)=>claim('x'.repeat(limit),`${i}.txt`)))); checks++;
    rejects(mutation(Array.from({length:5}, (_,i)=>claim('x'.repeat(i===4 ? 1 : limit),`${i}.txt`))), 'MUTATION_TOTAL_LIMIT_EXCEEDED');
    r.parseTextFileUpdates(mutation(Array.from({length:32}, (_,i)=>claim('x',`${i}.txt`)))); checks++;
    rejects(mutation(Array.from({length:33}, (_,i)=>claim('x',`${i}.txt`))), 'MUTATION_FILE_COUNT_EXCEEDED');
    for (const content of ['', '\ufeffTürkçe\r\n', 'changed']) {
      const m = mutation([claim(content)]);
      assert.equal((await verify(m)).decision, 'approve');
      const repair = {...m, role:'remask', target:'repairDraft', claims:m.claims.map(c=>({...c,type:'repair_draft'}))};
      const context = { fileContents: {'a.txt':source}, allowedFiles:['a.txt'] };
      const finding = r.verifyRepairDraftMutation(repair, context);
      assert.equal(finding.decision,'approve',JSON.stringify(finding));
      const dry = r.dryRunPatchApplication(repair, finding.finding, context);
      assert.equal(dry.decision,'ready_to_apply',JSON.stringify(dry));
      const applied = r.applyToTemporaryWorkspace(repair, finding.finding, dry, context);
      assert.equal(applied.decision,'temp_apply_ready',JSON.stringify(applied));
      assert.equal(applied.appliedFiles[0].appliedContent,content); checks++;
    }
    for (const n of [limit-1,limit,limit+1]) {
      const bytes = Buffer.alloc(n,120);
      const c = { ...claim('new'), expectedContentHash:r.mutationContentHash(bytes) };
      if (n>limit) assert.throws(()=>r.validateUpdateSource(c,bytes), e=>e.code==='MUTATION_FILE_LIMIT_EXCEEDED');
      else r.validateUpdateSource(c,bytes);
      checks++;
    }
    const sourceMap = Object.fromEntries(Array.from({length:5},(_,i)=>[`${i}.txt`,'x'.repeat(i===4?1:limit)]));
    const sourceClaims = Object.entries(sourceMap).map(([file,content])=>({...claim('new',file),expectedContentHash:hash(content)}));
    r.validateUpdateSourceMap(sourceClaims.slice(0,4),sourceMap); checks++;
    assert.throws(()=>r.validateUpdateSourceMap(sourceClaims,sourceMap),e=>e.code==='MUTATION_TOTAL_LIMIT_EXCEEDED'); checks++;
    const mixed = [claim(source),claim('changed','b.txt')];
    assert.throws(()=>r.validateUpdateSourceMap(mixed,{'a.txt':source,'b.txt':source}),e=>e.code==='MUTATION_NO_CHANGE'); checks++;
    assert((await verify(mutation([claim(source)]))).issues.some(i=>i.ruleId==='MUTATION_NO_CHANGE')); checks++;
    for (const [bytes,code] of [[Buffer.from([255]),'MUTATION_UTF8_INVALID'],[Buffer.from([0]),'MUTATION_BINARY_UNSUPPORTED'],[Buffer.alloc(limit+1,120),'MUTATION_FILE_LIMIT_EXCEEDED']]) {
      await fs.writeFile(path.join(root,'a.txt'),bytes);
      assert((await verify(mutation())).issues.some(i=>i.ruleId===code)); checks++;
    }
    await fs.unlink(path.join(root,'a.txt'));
    assert((await verify(mutation())).issues.some(i=>i.ruleId==='MUTATION_SOURCE_HASH_MISMATCH')); checks++;
    const absent = await r.verifyPatchDraftMutationV2({repositoryPath:root, mutation:mutation(), allowedFiles:['a.txt'], boundContextFiles:[]});
    assert(absent.issues.some(i=>i.ruleId==='MUTATION_CREATE_UNSUPPORTED')); checks++;
    await fs.mkdir(path.join(root,'a.txt'));
    assert((await verify(mutation())).issues.some(i=>i.ruleId==='MUTATION_FILE_TYPE_UNSUPPORTED')); checks++;
    await fs.rmdir(path.join(root,'a.txt'));
    await fs.symlink('other.txt',path.join(root,'a.txt'));
    assert((await verify(mutation())).issues.some(i=>i.ruleId==='MUTATION_SYMLINK_UNSUPPORTED')); checks++;
    console.log(`text file update contract passed (${checks} checks)`);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
})().catch(e=>{console.error(e);process.exitCode=1;});
