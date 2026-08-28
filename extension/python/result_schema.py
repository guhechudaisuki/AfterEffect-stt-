def validate_result(result):
    if not isinstance(result, dict):
        raise ValueError("result must be an object")
    if "error" in result:
        return result
    if not isinstance(result.get("segments"), list):
        raise ValueError("segments must be an array")
    previous = -1
    for index, segment in enumerate(result["segments"]):
        if not isinstance(segment, dict):
            raise ValueError("segment %d must be an object" % index)
        start = int(segment.get("startMs", -1))
        end = int(segment.get("endMs", -1))
        if start < previous or end < start:
            raise ValueError("invalid segment timing at %d" % index)
        words = segment.get("words") or []
        if not isinstance(words, list):
            raise ValueError("segment words must be an array at %d" % index)
        previous_word = start
        for word_index, word in enumerate(words):
            if not isinstance(word, dict):
                raise ValueError("word must be an object at %d:%d" % (index, word_index))
            word_start = int(word.get("startMs", -1))
            word_end = int(word.get("endMs", -1))
            if word_start < start or word_start < previous_word or word_end < word_start or word_end > end:
                raise ValueError("invalid word timing at %d:%d" % (index, word_index))
            previous_word = word_start
        previous = start
    return result
