#
#  Copyright 2025 The InfiniFlow Authors. All Rights Reserved.
#
#  Licensed under the Apache License, Version 2.0 (the "License");
#  you may not use this file except in compliance with the License.
#  You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
#
#  Unless required by applicable law or agreed to in writing, software
#  distributed under the License is distributed on an "AS IS" BASIS,
#  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
#  See the License for the specific language governing permissions and
#  limitations under the License.
import json
import logging
import random
import re
from copy import deepcopy

import xxhash

from api.db.joint_services.tenant_model_service import get_model_config_by_type_and_name
from api.db.services.llm_service import LLMBundle
from api.db.services.tenant_llm_service import TenantLLMService
from agent.component.llm import LLMParam, LLM
from common.metadata_utils import update_metadata_to
from rag.flow.base import ProcessBase, ProcessParamBase
from rag.prompts.generator import run_toc_from_text


class ExtractorParam(ProcessParamBase, LLMParam):
    def __init__(self):
        super().__init__()
        self.mode = "llm"
        self.field_name = ""
        self.title_page_only = False
        self.keyword_regexes = []
        self.metadata_regexes = []

    def check(self):
        self.check_empty(self.field_name, "Result Destination")
        if self.mode == "regex":
            self.check_valid_value(self.field_name, "Result Destination", ["metadata", "keywords"])
            if self.field_name == "metadata":
                self.check_empty(self.metadata_regexes, "Metadata regular expressions")
                for item in self.metadata_regexes:
                    key = item.get("key", "") if isinstance(item, dict) else ""
                    expressions = item.get("expressions", []) if isinstance(item, dict) else []
                    self.check_empty(key, "Metadata field key")
                    self.check_empty(expressions, f"Regular expressions for metadata field `{key}`")
            else:
                self.check_empty(self.keyword_regexes, "Keyword regular expressions")
            return

        super().check()


class Extractor(ProcessBase, LLM):
    component_name = "Extractor"

    def __init__(self, canvas, component_id, param: ExtractorParam):
        ProcessBase.__init__(self, canvas, component_id, param)
        self.chat_mdl = None
        self.imgs = []
        if self._param.mode == "regex":
            return

        chat_model_config = get_model_config_by_type_and_name(
            self._canvas.get_tenant_id(),
            TenantLLMService.llm_id2llm_type(self._param.llm_id),
            self._param.llm_id,
        )
        self.chat_mdl = LLMBundle(
            self._canvas.get_tenant_id(),
            chat_model_config,
            max_retries=self._param.max_retries,
            retry_interval=self._param.delay_after_error,
        )

    async def _build_TOC(self, docs):
        self.callback(0.2,message="Start to generate table of content ...")
        docs = sorted(docs, key=lambda d:(
            d.get("page_num_int", 0)[0] if isinstance(d.get("page_num_int", 0), list) else d.get("page_num_int", 0),
            d.get("top_int", 0)[0] if isinstance(d.get("top_int", 0), list) else d.get("top_int", 0)
        ))
        toc = await run_toc_from_text([d["text"] for d in docs], self.chat_mdl)
        logging.info("------------ T O C -------------\n"+json.dumps(toc, ensure_ascii=False, indent='  '))
        ii = 0
        while ii < len(toc):
            try:
                idx = int(toc[ii]["chunk_id"])
                del toc[ii]["chunk_id"]
                toc[ii]["ids"] = [docs[idx]["id"]]
                if ii == len(toc) -1:
                    break
                for jj in range(idx+1, int(toc[ii+1]["chunk_id"])+1):
                    toc[ii]["ids"].append(docs[jj]["id"])
            except Exception as e:
                logging.exception(e)
            ii += 1

        if toc:
            d = deepcopy(docs[-1])
            d["doc_id"] = self._canvas._doc_id
            d["content_with_weight"] = json.dumps(toc, ensure_ascii=False)
            d["toc_kwd"] = "toc"
            d["available_int"] = 0
            d["page_num_int"] = [100000000]
            d["id"] = xxhash.xxh64((d["content_with_weight"] + str(d["doc_id"])).encode("utf-8", "surrogatepass")).hexdigest()
            return d
        return None

    @staticmethod
    def _normalize_regex_matches(matches):
        normalized = []
        for match in matches:
            if isinstance(match, tuple):
                values = [str(item) for item in match if item not in [None, ""]]
                if values:
                    normalized.append(" ".join(values))
                continue
            if match in [None, ""]:
                continue
            normalized.append(str(match))
        return normalized

    @staticmethod
    def _dedupe(values):
        seen = set()
        deduped = []
        for value in values:
            if value in seen:
                continue
            seen.add(value)
            deduped.append(value)
        return deduped

    def _extract_keywords_by_regex(self, text):
        keywords = []
        for idx, expression in enumerate(self._param.keyword_regexes, start=1):
            expression = expression.get("expression", "") if isinstance(expression, dict) else expression
            matches = []
            try:
                matches = self._normalize_regex_matches(re.findall(expression, text, re.MULTILINE))
            except Exception as exc:
                logging.warning("Invalid keyword regex `%s`: %s", expression, exc)
            self.callback(
                0.1,
                f'Regex [{idx}] for keywords found [{len(matches)}] matches.',
            )
            keywords.extend(matches)
        keywords = self._dedupe(keywords)
        return ",".join(keywords)

    def _extract_metadata_by_regex(self, text):
        metadata = {}
        for item in self._param.metadata_regexes:
            key = item.get("key", "")
            expressions = item.get("expressions", [])
            values = []
            for idx, expression in enumerate(expressions, start=1):
                expression = expression.get("expression", "") if isinstance(expression, dict) else expression
                matches = []
                try:
                    matches = self._normalize_regex_matches(re.findall(expression, text, re.MULTILINE))
                except Exception as exc:
                    logging.warning(
                        "Invalid metadata regex `%s` for field `%s`: %s",
                        expression,
                        key,
                        exc,
                    )
                self.callback(
                    0.1,
                    f'Regex [{idx}] for metadata field "{key}" found [{len(matches)}] matches.',
                )
                values.extend(matches)
            values = self._dedupe(values)
            if values:
                metadata[key] = values if len(values) > 1 else values[0]
        return metadata

    @staticmethod
    def _metadata_for_doc_store(meta):
        if not meta or not isinstance(meta, dict):
            return {}
        out = {}
        for k, v in meta.items():
            if isinstance(v, list):
                out[k] = [str(x) for x in v if x is not None and str(x).strip() != ""]
            elif v is not None and str(v).strip() != "":
                out[k] = str(v)
        return out

    def _extract_by_regex(self, text):
        txt = "" if text is None else str(text)
        if self._param.field_name == "metadata":
            return self._extract_metadata_by_regex(txt)
        if self._param.field_name == "keywords":
            return self._extract_keywords_by_regex(txt)
        return ""

    @staticmethod
    def _coerce_page_number(value):
        if value is None:
            return None
        if isinstance(value, (int, float)):
            return int(value)
        if isinstance(value, str):
            matched = re.search(r"\d+", value)
            if matched:
                return int(matched.group(0))
        return None

    def _get_chunk_pages(self, chunk):
        pages = []
        page_num_int = chunk.get("page_num_int")
        if isinstance(page_num_int, list):
            for item in page_num_int:
                page = self._coerce_page_number(item)
                if page is not None:
                    pages.append(page)
        elif page_num_int is not None:
            page = self._coerce_page_number(page_num_int)
            if page is not None:
                pages.append(page)

        if pages:
            return sorted(set(pages))

        for position_key in ["positions", "position_int"]:
            positions = chunk.get(position_key) or []
            for position in positions:
                page = None
                if isinstance(position, dict):
                    page = self._coerce_page_number(position.get("page_number"))
                elif isinstance(position, (list, tuple)) and position:
                    page = self._coerce_page_number(position[0])
                if page is not None:
                    pages.append(page)

        return sorted(set(pages))

    def _get_first_page_number(self, chunks):
        pages = []
        for chunk in chunks:
            pages.extend(self._get_chunk_pages(chunk))
        return min(pages) if pages else None

    def _is_target_page_chunk(self, chunk, first_page_number):
        if not self._param.title_page_only or first_page_number is None:
            return True
        return first_page_number in self._get_chunk_pages(chunk)

    async def _invoke(self, **kwargs):
        self.set_output("output_format", "chunks")
        self.callback(random.randint(1, 5) / 100.0, "Start to generate.")
        inputs = self.get_input_elements()
        chunks = []
        chunks_key = ""
        args = {}
        for k, v in inputs.items():
            args[k] = v["value"]
            if isinstance(args[k], list):
                chunks = deepcopy(args[k])
                chunks_key = k

        if chunks:
            if self._param.field_name == "toc":
                for ck in chunks:
                    ck["doc_id"] = self._canvas._doc_id
                    ck["id"] = xxhash.xxh64((ck["text"] + str(ck["doc_id"])).encode("utf-8")).hexdigest()
                toc =await self._build_TOC(chunks)
                chunks.append(toc)
                self.set_output("chunks", chunks)
                return

            if self._param.mode == "regex":
                first_page_number = None
                if self._param.title_page_only:
                    first_page_number = self._get_first_page_number(chunks)
                    if first_page_number is None:
                        self.callback(
                            0.05,
                            "Title page only is enabled, but no page metadata was found. Applying regex to all chunks.",
                        )
                if self._param.field_name == "metadata":
                    doc_meta = {}
                    for i, ck in enumerate(chunks):
                        if not self._is_target_page_chunk(ck, first_page_number):
                            extracted = {}
                        else:
                            extracted = self._extract_by_regex(ck.get("text", ""))
                        if isinstance(extracted, dict) and extracted:
                            doc_meta = update_metadata_to(doc_meta, self._metadata_for_doc_store(extracted))
                        prog = (i + 1.0) / len(chunks)
                        if i % (len(chunks)//100+1) == 1:
                            self.callback(prog, f"{i+1} / {len(chunks)}")
                    for ck in chunks:
                        ck["metadata"] = deepcopy(doc_meta) if doc_meta else {}
                    self.set_output("chunks", chunks)
                    return
                for i, ck in enumerate(chunks):
                    if not self._is_target_page_chunk(ck, first_page_number):
                        extracted = ""
                    else:
                        extracted = self._extract_by_regex(ck.get("text", ""))
                    if self._param.field_name == "keywords" and not extracted:
                        ck.pop("keywords", None)
                    else:
                        ck[self._param.field_name] = extracted
                    prog = (i + 1.0) / len(chunks)
                    if i % (len(chunks)//100+1) == 1:
                        self.callback(prog, f"{i+1} / {len(chunks)}")
                self.set_output("chunks", chunks)
                return

            if self._param.field_name == "metadata" and self._param.title_page_only:
                first_page_number = self._get_first_page_number(chunks)
                target_chunks = chunks
                if first_page_number is not None:
                    target_chunks = [ck for ck in chunks if self._is_target_page_chunk(ck, first_page_number)]
                else:
                    self.callback(
                        0.05,
                        "Title page only is enabled, but no page metadata was found. Applying extraction to all chunks.",
                    )

                title_page_context = "\n".join(
                    [
                        str(ck.get("text", "")).strip()
                        for ck in target_chunks
                        if str(ck.get("text", "")).strip()
                    ]
                )
                args[chunks_key] = title_page_context
                msg, sys_prompt = self._sys_prompt_and_msg([], args)
                msg.insert(0, {"role": "system", "content": sys_prompt})
                extracted = await self._generate_async(msg)

                for i, ck in enumerate(chunks):
                    ck[self._param.field_name] = extracted
                    prog = (i + 1.0) / len(chunks)
                    if i % (len(chunks) // 100 + 1) == 1:
                        self.callback(prog, f"{i+1} / {len(chunks)}")
                self.set_output("chunks", chunks)
                return

            prog = 0
            for i, ck in enumerate(chunks):
                args[chunks_key] = ck["text"]
                msg, sys_prompt = self._sys_prompt_and_msg([], args)
                msg.insert(0, {"role": "system", "content": sys_prompt})
                ck[self._param.field_name] = await self._generate_async(msg)
                prog += 1./len(chunks)
                if i % (len(chunks)//100+1) == 1:
                    self.callback(prog, f"{i+1} / {len(chunks)}")
            self.set_output("chunks", chunks)
        else:
            if self._param.mode == "regex":
                plain_text = "\n".join([str(v) for v in args.values() if isinstance(v, (str, int, float))])
                extracted = self._extract_by_regex(plain_text)
                if self._param.field_name == "keywords" and not extracted:
                    self.set_output("chunks", [{}])
                else:
                    if self._param.field_name == "metadata" and isinstance(extracted, dict):
                        extracted = self._metadata_for_doc_store(extracted)
                    self.set_output("chunks", [{self._param.field_name: extracted}])
                return
            msg, sys_prompt = self._sys_prompt_and_msg([], args)
            msg.insert(0, {"role": "system", "content": sys_prompt})
            self.set_output("chunks", [{self._param.field_name: await self._generate_async(msg)}])


